// drive-inbox.ts — the Google Drive folder where the bank download files (.qbo/.ofx/.csv) are dropped.
//
// Curia reads the folder with a Google service account, which can see only what is shared with it. The service
// account key and the folder id live encrypted in the vault (`books_drive`). Curia never opens the files: it lists
// them, hands the bytes to the books agent over the books token, and moves a file to a "Processed" subfolder once
// the agent says the batch is made.

import { google } from 'googleapis';

const SECRET_NAME = 'books_drive';
const PROCESSED_FOLDER = 'Processed';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ALLOWED_EXTENSIONS = ['.qbo', '.ofx', '.csv'];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
}

/** The few Drive calls this needs; the real one wraps googleapis, tests use a fake. */
export interface DrivePort {
  listChildren(folderId: string): Promise<DriveFileMeta[]>;
  getMeta(fileId: string): Promise<DriveFileMeta>;
  download(fileId: string, maxBytes: number): Promise<Buffer>;
  findOrCreateFolder(parentId: string, name: string): Promise<string>;
  move(fileId: string, fromFolderId: string, toFolderId: string): Promise<void>;
}

export interface ServiceAccount {
  type: string;
  client_email: string;
  private_key: string;
  [k: string]: unknown;
}

interface StoredDrive {
  serviceAccount: ServiceAccount;
  folderId: string;
}

export interface DriveSecretsPort {
  getJSON<T>(name: string): Promise<T | null>;
  setJSON(name: string, obj: unknown): Promise<void>;
}

export class DriveSettingsError extends Error {}
/** The file is not one the books agent may touch (not in the folder, wrong type, too big). */
export class DriveFileError extends Error {}

export interface DriveStatus {
  configured: boolean;
  serviceAccountEmail?: string;
  folderId?: string;
  folderName?: string;
  reachable?: boolean;
  problem?: string;
}

export function googleDrivePort(serviceAccount: ServiceAccount): DrivePort {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const fields = 'id,name,mimeType,size,modifiedTime,md5Checksum,parents';
  return {
    async listChildren(folderId) {
      const out: DriveFileMeta[] = [];
      let pageToken: string | undefined;
      do {
        const res = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: `nextPageToken,files(${fields})`,
          pageSize: 200,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        out.push(...((res.data.files ?? []) as DriveFileMeta[]));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    },
    async getMeta(fileId) {
      const res = await drive.files.get({ fileId, fields, supportsAllDrives: true });
      return res.data as DriveFileMeta;
    },
    async download(fileId, maxBytes) {
      const res = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer', maxContentLength: maxBytes },
      );
      return Buffer.from(res.data as ArrayBuffer);
    },
    async findOrCreateFolder(parentId, name) {
      const found = await drive.files.list({
        q: `'${parentId}' in parents and name = '${name}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const id = found.data.files?.[0]?.id;
      if (id) return id;
      const made = await drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
        fields: 'id',
        supportsAllDrives: true,
      });
      if (!made.data.id) throw new Error('Drive did not return the new folder id');
      return made.data.id;
    },
    async move(fileId, fromFolderId, toFolderId) {
      await drive.files.update({
        fileId,
        addParents: toFolderId,
        removeParents: fromFolderId,
        fields: 'id',
        supportsAllDrives: true,
      });
    },
  };
}

/** The folder id from a Drive folder link, or the id itself. */
export function parseFolderId(input: string): string | null {
  const t = input.trim();
  const m = /\/folders\/([\w-]+)/.exec(t) ?? /[?&]id=([\w-]+)/.exec(t);
  const id = m ? m[1]! : t;
  return /^[\w-]{10,100}$/.test(id) ? id : null;
}

const extensionOk = (name: string): boolean => ALLOWED_EXTENSIONS.some(e => name.toLowerCase().endsWith(e));

export class DriveInbox {
  constructor(
    private readonly secrets: DriveSecretsPort,
    private readonly makePort: (sa: ServiceAccount) => DrivePort = googleDrivePort,
  ) {}

  /** Saves the service account key and the folder, after proving the folder can be read with them. */
  async saveSettings(input: { serviceAccountJson?: unknown; folder?: unknown }): Promise<{ serviceAccountEmail: string; folderName: string }> {
    let sa: ServiceAccount;
    try {
      sa = JSON.parse(typeof input.serviceAccountJson === 'string' ? input.serviceAccountJson : '') as ServiceAccount;
    } catch {
      throw new DriveSettingsError('The service account key must be the JSON file Google gave you');
    }
    if (sa?.type !== 'service_account' || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') {
      throw new DriveSettingsError('That is not a Google service account key (it needs type, client_email and private_key)');
    }
    const folderId = typeof input.folder === 'string' ? parseFolderId(input.folder) : null;
    if (!folderId) throw new DriveSettingsError('Paste the folder\'s link from Google Drive');
    let folderName: string;
    try {
      const meta = await this.makePort(sa).getMeta(folderId);
      if (meta.mimeType !== FOLDER_MIME) throw new DriveSettingsError('That link is a file, not a folder');
      folderName = meta.name;
    } catch (err) {
      if (err instanceof DriveSettingsError) throw err;
      throw new DriveSettingsError(`Google would not let ${sa.client_email} open that folder. Share the folder with that address (Editor) and try again`);
    }
    await this.secrets.setJSON(SECRET_NAME, { serviceAccount: sa, folderId } satisfies StoredDrive);
    return { serviceAccountEmail: sa.client_email, folderName };
  }

  async status(): Promise<DriveStatus> {
    const s = await this.secrets.getJSON<StoredDrive>(SECRET_NAME);
    if (!s) return { configured: false };
    const base = { configured: true, serviceAccountEmail: s.serviceAccount.client_email, folderId: s.folderId };
    try {
      const meta = await this.makePort(s.serviceAccount).getMeta(s.folderId);
      return { ...base, folderName: meta.name, reachable: true };
    } catch {
      return { ...base, reachable: false, problem: `Google would not let ${s.serviceAccount.client_email} open the folder: is it still shared with that address?` };
    }
  }

  private async load(): Promise<{ s: StoredDrive; port: DrivePort }> {
    const s = await this.secrets.getJSON<StoredDrive>(SECRET_NAME);
    if (!s) throw new DriveSettingsError('The bank files folder is not set up: do it on the API connections page');
    return { s, port: this.makePort(s.serviceAccount) };
  }

  /** The bank files waiting in the folder (not the Processed subfolder), oldest first. */
  async list(): Promise<Array<{ id: string; name: string; size: number; modifiedTime: string; md5: string }>> {
    const { s, port } = await this.load();
    return (await port.listChildren(s.folderId))
      .filter(f => f.mimeType !== FOLDER_MIME && extensionOk(f.name) && Number(f.size ?? 0) <= MAX_FILE_BYTES)
      .map(f => ({ id: f.id, name: f.name, size: Number(f.size ?? 0), modifiedTime: f.modifiedTime ?? '', md5: f.md5Checksum ?? '' }))
      .sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime));
  }

  /** A file is only handed out if it sits directly in the folder and looks like a bank file. */
  private async checkedFile(port: DrivePort, folderId: string, fileId: string): Promise<DriveFileMeta> {
    let meta: DriveFileMeta;
    try {
      meta = await port.getMeta(fileId);
    } catch {
      throw new DriveFileError('No such file');
    }
    if (!meta.parents?.includes(folderId) || meta.mimeType === FOLDER_MIME) throw new DriveFileError('That file is not in the bank files folder');
    if (!extensionOk(meta.name)) throw new DriveFileError('Only .qbo, .ofx and .csv files are handed out');
    if (Number(meta.size ?? 0) > MAX_FILE_BYTES) throw new DriveFileError('That file is too large');
    return meta;
  }

  async read(fileId: string): Promise<{ name: string; bytes: Buffer }> {
    const { s, port } = await this.load();
    const meta = await this.checkedFile(port, s.folderId, fileId);
    return { name: meta.name, bytes: await port.download(fileId, MAX_FILE_BYTES) };
  }

  /** Moves the file into the Processed subfolder so it is never picked up twice. */
  async markProcessed(fileId: string): Promise<void> {
    const { s, port } = await this.load();
    await this.checkedFile(port, s.folderId, fileId);
    const processed = await port.findOrCreateFolder(s.folderId, PROCESSED_FOLDER);
    await port.move(fileId, s.folderId, processed);
  }
}
