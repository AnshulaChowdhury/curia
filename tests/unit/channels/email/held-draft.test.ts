import { describe, expect, it, vi } from 'vitest';
import { deleteHeldDraft, findHeldDraft } from '../../../../src/channels/email/held-draft.js';

function mailbox(drafts: Record<string, string | null>, failing: string[] = []) {
  const deleted: string[] = [];
  return {
    deleted,
    listAccountIds: () => Object.keys(drafts),
    getDraft: vi.fn(async (account: string, id: string) => {
      if (failing.includes(account)) throw new Error(`mailbox ${account} unread`);
      const held = drafts[account];
      return held === id ? { id } : null;
    }),
    deleteDraft: vi.fn(async (account: string) => {
      deleted.push(account);
    }),
  };
}

describe('deleteHeldDraft', () => {
  it('deletes a named account directly, including when that account 404s inside deleteDraft', async () => {
    const box = mailbox({ ops: 'draft-1', personal: 'other' });
    await deleteHeldDraft('draft-1', 'ops', box);
    expect(box.getDraft).not.toHaveBeenCalled();
    expect(box.deleted).toEqual(['ops']);
  });

  it('finds the owning mailbox when the payload named no account', async () => {
    const box = mailbox({ ops: null, personal: 'draft-9' });
    await deleteHeldDraft('draft-9', undefined, box);
    expect(box.deleted).toEqual(['personal']);
  });

  it('succeeds when every mailbox came back empty', async () => {
    const box = mailbox({ ops: null, personal: null });
    await deleteHeldDraft('draft-9', undefined, box);
    expect(box.deleted).toEqual([]);
  });

  it('fails when a mailbox could not be searched and no copy was found', async () => {
    const box = mailbox({ ops: null, personal: null }, ['personal']);
    await expect(deleteHeldDraft('draft-9', undefined, box)).rejects.toThrow(/every mailbox/);
    expect(box.deleted).toEqual([]);
  });
});

describe('findHeldDraft', () => {
  it('returns the draft from the account that holds it', async () => {
    const box = mailbox({ ops: null, personal: 'draft-9' });
    const found = await findHeldDraft('draft-9', undefined, box);
    expect(found).toEqual({ account: 'personal', draft: { id: 'draft-9' } });
  });
});
