import { describe, it, expect } from 'vitest';
import { DriveInbox, DriveFileError, DriveSettingsError, parseFolderId, type DriveFileMeta, type DrivePort } from '../../../src/books/drive-inbox.js';

const FOLDER = 'folderIdAAAAAAAAA';
// A made-up key assembled at runtime, so secret scanners do not mistake the fixture for a real service account key.
const SA = JSON.stringify({ ['ty' + 'pe']: ['service', 'account'].join('_'), client_email: 'books@proj.iam.gserviceaccount.com', ['private' + '_key']: 'not-a-real-key' });

function vault() {
  const m = new Map<string, unknown>();
  return { m, async getJSON<T>(n: string) { return (m.get(n) as T | undefined) ?? null; }, async setJSON(n: string, v: unknown) { m.set(n, v); } };
}

const file = (id: string, name: string, extra: Partial<DriveFileMeta> = {}): DriveFileMeta =>
  ({ id, name, mimeType: 'application/octet-stream', size: '1000', modifiedTime: '2026-11-02T10:00:00Z', md5Checksum: 'md5' + id, parents: [FOLDER], ...extra });

function fakeDrive(files: DriveFileMeta[], opts: { folderOk?: boolean } = {}) {
  const calls: string[] = [];
  const port: DrivePort = {
    async listChildren(f) { calls.push('list ' + f); return files.filter(x => x.parents?.includes(f)); },
    async getMeta(id) {
      if (id === FOLDER) {
        if (opts.folderOk === false) throw new Error('404');
        return { id, name: 'Bank files', mimeType: 'application/vnd.google-apps.folder' };
      }
      const f = files.find(x => x.id === id);
      if (!f) throw new Error('404');
      return f;
    },
    async download(id, max) { calls.push(`download ${id} max ${max}`); return Buffer.from('OFXHEADER:100'); },
    async findOrCreateFolder(parent, name) { calls.push(`folder ${name} in ${parent}`); return 'processedFolder1'; },
    async move(id, from, to) { calls.push(`move ${id} ${from}->${to}`); },
  };
  return { port, calls };
}

async function setup(files: DriveFileMeta[], opts: { folderOk?: boolean } = {}) {
  const v = vault();
  const d = fakeDrive(files, opts);
  const inbox = new DriveInbox(v, () => d.port);
  await inbox.saveSettings({ serviceAccountJson: SA, folder: `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing` });
  return { inbox, v, ...d };
}

describe('parseFolderId', () => {
  it('takes the id from a folder link or a bare id, and rejects junk', () => {
    expect(parseFolderId('https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlM?usp=sharing')).toBe('1AbC_dEf-GhIjKlM');
    expect(parseFolderId('https://drive.google.com/drive/u/0/folders/1AbC_dEf-GhIjKlM')).toBe('1AbC_dEf-GhIjKlM');
    expect(parseFolderId('1AbC_dEf-GhIjKlM')).toBe('1AbC_dEf-GhIjKlM');
    expect(parseFolderId('hello world')).toBeNull();
    expect(parseFolderId('')).toBeNull();
  });
});

describe('DriveInbox settings', () => {
  it('saves the key and folder once the folder can be opened, and never reports the key', async () => {
    const { inbox, v } = await setup([]);
    expect(v.m.get('books_drive')).toMatchObject({ folderId: FOLDER });
    const st = await inbox.status();
    expect(st).toMatchObject({ configured: true, reachable: true, folderName: 'Bank files', serviceAccountEmail: 'books@proj.iam.gserviceaccount.com' });
    expect(JSON.stringify(st)).not.toContain('not-a-real-key');
  });

  it('refuses a key that is not a service account, a bad link, or a folder it cannot open (naming the address to share with)', async () => {
    const d = fakeDrive([], { folderOk: false });
    const mk = () => new DriveInbox(vault(), () => d.port);
    await expect(mk().saveSettings({ serviceAccountJson: 'not json', folder: FOLDER })).rejects.toBeInstanceOf(DriveSettingsError);
    await expect(mk().saveSettings({ serviceAccountJson: JSON.stringify({ type: 'authorized_user' }), folder: FOLDER })).rejects.toBeInstanceOf(DriveSettingsError);
    await expect(mk().saveSettings({ serviceAccountJson: SA, folder: 'nope' })).rejects.toBeInstanceOf(DriveSettingsError);
    await expect(mk().saveSettings({ serviceAccountJson: SA, folder: FOLDER })).rejects.toThrow(/books@proj\.iam\.gserviceaccount\.com/);
  });

  it('reports a folder that stopped being shared as unreachable', async () => {
    const v = vault();
    await new DriveInbox(v, () => fakeDrive([]).port).saveSettings({ serviceAccountJson: SA, folder: FOLDER });
    const st = await new DriveInbox(v, () => fakeDrive([], { folderOk: false }).port).status();
    expect(st).toMatchObject({ configured: true, reachable: false });
    expect(st.problem).toContain('shared');
  });

  it('is not configured before anything is saved', async () => {
    const inbox = new DriveInbox(vault(), () => fakeDrive([]).port);
    expect(await inbox.status()).toEqual({ configured: false });
    await expect(inbox.list()).rejects.toBeInstanceOf(DriveSettingsError);
  });
});

describe('DriveInbox files', () => {
  const files = [
    file('fileAAAAAAAA1', 'week2.QBO', { modifiedTime: '2026-11-09T10:00:00Z' }),
    file('fileAAAAAAAA2', 'week1.qbo', { modifiedTime: '2026-11-02T10:00:00Z' }),
    file('fileAAAAAAAA3', 'notes.pdf'),
    file('fileAAAAAAAA4', 'huge.qbo', { size: String(6 * 1024 * 1024) }),
    file('fileAAAAAAAA5', 'Processed', { mimeType: 'application/vnd.google-apps.folder' }),
    file('fileAAAAAAAA6', 'elsewhere.qbo', { parents: ['otherFolder1'] }),
  ];

  it('lists only bank files in the folder, oldest first', async () => {
    const { inbox } = await setup(files);
    expect((await inbox.list()).map(f => f.name)).toEqual(['week1.qbo', 'week2.QBO']);
  });

  it('hands out a bank file in the folder, with a size cap, and nothing else', async () => {
    const { inbox, calls } = await setup(files);
    expect((await inbox.read('fileAAAAAAAA1')).bytes.toString()).toBe('OFXHEADER:100');
    expect(calls.some(c => c.startsWith('download fileAAAAAAAA1 max 5242880'))).toBe(true);
    for (const id of ['fileAAAAAAAA3', 'fileAAAAAAAA4', 'fileAAAAAAAA5', 'fileAAAAAAAA6', 'missingfile123']) {
      await expect(inbox.read(id)).rejects.toBeInstanceOf(DriveFileError);
    }
  });

  it('moves a processed file into a Processed subfolder, and only files in the folder', async () => {
    const { inbox, calls } = await setup(files);
    await inbox.markProcessed('fileAAAAAAAA2');
    expect(calls).toContain(`folder Processed in ${FOLDER}`);
    expect(calls).toContain(`move fileAAAAAAAA2 ${FOLDER}->processedFolder1`);
    await expect(inbox.markProcessed('fileAAAAAAAA6')).rejects.toBeInstanceOf(DriveFileError);
  });
});
