// sources.test.ts — what the Sources drawer says about each place the import reads from.

import { describe, it, expect } from 'vitest';
import { buildSources, maskAddress, WAITING_FOR_PHONE_NOTE, type MailboxInput } from '../../../src/contacts-import/sources.js';
import type { ReportedCategory } from '../../../src/phone-inbox/mailbox-category-store.js';

const reported = (accountId: ReportedCategory['accountId'], category: ReportedCategory['category']): ReportedCategory =>
  ({ accountId, category, reportedAt: '2026-11-02T12:00:00.000Z', changedAt: '2026-11-02T12:00:00.000Z' });

const mailboxes: MailboxInput[] = [
  { id: 'personal', address: 'someone@gmail.example', connected: true },
  { id: 'moonray', address: 'ac@moonray.example', connected: true },
  { id: 'work-outlook', address: null, connected: false },
];
const find = (list: ReturnType<typeof buildSources>, key: string) => list.find((s) => s.key === key)!;

describe('maskAddress', () => {
  it('keeps the first letter and the domain only', () => {
    expect(maskAddress('anshula@example.com')).toBe('a***@example.com');
  });
  it('hides anything it cannot parse, and returns null for nothing', () => {
    expect(maskAddress('not-an-address')).toBe('***');
    expect(maskAddress('@example.com')).toBe('***');
    expect(maskAddress('a@')).toBe('***');
    expect(maskAddress(null)).toBeNull();
    expect(maskAddress('  ')).toBeNull();
  });
});

describe('buildSources: mailboxes', () => {
  it('imports nothing from a connected mailbox the phone has not reported, and says why in the owner\'s words', () => {
    const s = find(buildSources({ mailboxes, categories: [], bridges: [] }), 'mailbox:moonray');
    expect(s.status).toBe('waiting');
    expect(s.willImport).toBe(false);
    expect(s.category).toBeNull();
    expect(s.note).toBe('waiting for Command Hub (Android Launcher) to report the category');
    expect(WAITING_FOR_PHONE_NOTE).toBe(s.note);
  });

  it('reads a connected mailbox once the phone has reported Work or Personal', () => {
    const list = buildSources({ mailboxes, categories: [reported('moonray', 'WORK'), reported('personal', 'PERSONAL')], bridges: [] });
    expect(find(list, 'mailbox:moonray')).toMatchObject({ status: 'ready', willImport: true, category: 'WORK', note: 'Work, set on Command Hub.' });
    expect(find(list, 'mailbox:personal')).toMatchObject({ status: 'ready', willImport: true, category: 'PERSONAL' });
  });

  it('never shows a full address', () => {
    const json = JSON.stringify(buildSources({ mailboxes, categories: [], bridges: [] }));
    expect(json).not.toContain('someone@gmail.example');
    expect(json).not.toContain('ac@moonray.example');
    expect(json).toContain('s***@gmail.example');
  });

  it('skips Work Outlook even when the phone has reported it', () => {
    const s = find(buildSources({ mailboxes: [{ id: 'work-outlook', address: 'x@corp.example', connected: true }], categories: [reported('work-outlook', 'WORK')], bridges: [] }), 'mailbox:work-outlook');
    expect(s).toMatchObject({ status: 'skipped', willImport: false });
  });

  it('a mailbox without a grant is not connected, even if the phone reported a category', () => {
    const list = buildSources({ mailboxes: [{ id: 'personal', address: null, connected: false }], categories: [reported('personal', 'PERSONAL')], bridges: [] });
    expect(find(list, 'mailbox:personal')).toMatchObject({ status: 'not_connected', willImport: false, linkTo: '/connections' });
  });
});

describe('buildSources: other sources', () => {
  it('a bridge needs both its address and its secret', () => {
    const list = buildSources({
      mailboxes: [],
      categories: [],
      bridges: [
        { id: 'whatsapp', label: 'WhatsApp', hasUrl: true, hasSecret: true },
        { id: 'signal', label: 'Signal', hasUrl: true, hasSecret: false },
        { id: 'instagram', label: 'Instagram', hasUrl: false, hasSecret: false },
      ],
    });
    expect(find(list, 'bridge:whatsapp')).toMatchObject({ status: 'ready', willImport: true, linkTo: null });
    expect(find(list, 'bridge:signal')).toMatchObject({ status: 'not_connected', willImport: false, linkTo: '/connections' });
    expect(find(list, 'bridge:instagram')).toMatchObject({ status: 'not_connected', willImport: false });
  });

  it('always lists Google Contacts and Apple Contacts as not connected until they are built', () => {
    const list = buildSources({ mailboxes: [], categories: [], bridges: [] });
    expect(find(list, 'google_contacts')).toMatchObject({ status: 'not_connected', willImport: false });
    expect(find(list, 'apple_contacts')).toMatchObject({ status: 'not_connected', willImport: false });
  });
});
