// The budget spreadsheet attached to this chat: which it is, adding one, and taking it off.

import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFile, fileProblem } from '../../sheets/convert-client.js';
import { sheetClient, SheetError, type SheetInfo } from '../../sheets/sheet-client.js';

export const CHAT_PATH = '/chat';
/** After detaching, the grid stays loaded this long (hidden) so an edit still being saved is not cut off. */
export const DETACH_SETTLE_MS = 3_000;

/**
 * Whether this document was loaded as the chat page, and so carries the policy that lets it frame the sheet and the file
 * converter. A policy is fixed when a document loads: arriving here by in-app navigation does not bring it.
 */
export function loadedAsChatPage(entry: string | undefined): boolean {
  if (!entry) return true;
  return new URL(entry, 'http://local').pathname.replace(/\/$/, '') === CHAT_PATH;
}

const message = (err: unknown): string =>
  err instanceof SheetError && err.locked ? 'Budget data is private to the owner.' : err instanceof Error ? err.message : 'Something went wrong.';

export interface ChatSheet {
  sheet: SheetInfo | null;
  /** A detached sheet that is still being let go. */
  leaving: SheetInfo | null;
  busy: boolean;
  error: string | null;
  add: (file: File) => Promise<void>;
  detach: () => Promise<void>;
}

export function useChatSheet(
  conversationId: string | null,
  ensureConversationId: () => string,
  client: Pick<typeof sheetClient, 'attached' | 'create' | 'detach'> = sheetClient,
  convert: (file: File) => Promise<unknown> = convertFile,
): ChatSheet {
  const [sheet, setSheet] = useState<SheetInfo | null>(null);
  const [leaving, setLeaving] = useState<SheetInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by every change made here, so a lookup that started earlier cannot undo it.
  const changes = useRef(0);

  useEffect(() => {
    if (!conversationId) return;
    const before = changes.current;
    client.attached(conversationId).then(
      found => { if (changes.current === before) setSheet(found); },
      // A viewer who may not see budget data, or a server without it, simply has nothing attached.
      err => console.error('[useChatSheet] could not look up the attached sheet:', err),
    );
  }, [conversationId, client]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), DETACH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const add = useCallback(async (file: File) => {
    const problem = fileProblem(file);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const workbook = await convert(file);
      changes.current += 1;
      setSheet(await client.create(file.name.replace(/\.(xlsx|csv)$/i, ''), workbook, ensureConversationId()));
    } catch (err) {
      console.error('[useChatSheet] attach failed:', err);
      setError(message(err));
    }
    setBusy(false);
  }, [client, convert, ensureConversationId]);

  const detach = useCallback(async () => {
    if (!conversationId || !sheet) return;
    setError(null);
    try {
      changes.current += 1;
      await client.detach(conversationId);
      setLeaving(sheet);
      setSheet(null);
    } catch (err) {
      console.error('[useChatSheet] detach failed:', err);
      setError(message(err));
    }
  }, [client, conversationId, sheet]);

  return { sheet, leaving, busy, error, add, detach };
}
