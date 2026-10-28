// Optional task and contact ids on task-create and task-update (#2328).
//
// Models fill an optional id with "null", "none", "", or a word. Postgres then
// rejects the write with a raw uuid error, and the retry invents an id to get
// past it. On create, null-like placeholders are omitted. On update, the same
// strings are rejected: a silent success would leave a blocker in place while
// the model believes it cleared one. Anything else that is not a UUID is
// rejected with a message that says to omit the field.

import { isUnresolvedPlaceholder } from '../../src/skills/_shared/placeholder-guard.js';
import { isUuid } from '../../src/util/uuid.js';

const NULLISH_ID = new Set(['null', 'none', 'undefined']);

export const BLOCKED_BY_TASK_ID_ERROR =
  'blocked_by_task_id must be a task UUID from task-list or a prior task-create; omit it if the task is not blocked';

export const PARENT_TASK_ID_ERROR =
  'parent_task_id must be a task UUID from task-list or a prior task-create; omit it if the task has no parent';

export const WAITING_ON_CONTACT_ID_ERROR =
  'waiting_on_contact_id must be a contact UUID; omit it if the task is not waiting on a person';

export const SELF_BLOCK_ERROR = 'blocked_by_task_id cannot be the task itself';

export type ResolvedOptionalId =
  | { ok: true; id: string | undefined }
  | { ok: false; error: string };

/**
 * A null-like blocker string on task-update.
 *
 * Create omits these. Update must not: `{ status: 'open', blocked_by_task_id: 'null' }`
 * would otherwise succeed and leave the real blocker set. JSON null is the clear.
 */
export function placeholderBlockerError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || NULLISH_ID.has(trimmed.toLowerCase())) {
    return (
      `blocked_by_task_id: ${JSON.stringify(trimmed)} is a string; ` +
      'pass JSON null to clear the blocker, or omit the field.'
    );
  }
  return null;
}

/**
 * Normalize one optional id for task-create.
 *
 * `null`, `undefined`, blank, and the words null/none/undefined (any case) are
 * omitted. A copied `${...}` token is rejected with `invalidError` plus the
 * token text. The shared placeholder error is not used: it tells the model to
 * paste the principal's contact id, which is the wrong recovery for a task or
 * a third-party contact.
 */
export function resolveOptionalId(
  field: string,
  raw: unknown,
  invalidError: string,
): ResolvedOptionalId {
  if (raw === undefined || raw === null) return { ok: true, id: undefined };
  if (typeof raw !== 'string') return { ok: false, error: invalidError };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || NULLISH_ID.has(trimmed.toLowerCase())) {
    return { ok: true, id: undefined };
  }
  if (isUnresolvedPlaceholder(trimmed)) {
    return {
      ok: false,
      error: `${invalidError}. Got the literal token ${trimmed} in "${field}"; do not copy \${...} tokens into this field.`,
    };
  }
  if (!isUuid(trimmed)) return { ok: false, error: invalidError };
  return { ok: true, id: trimmed };
}

export function taskNotFoundError(field: string, id: string): string {
  return `${field}: task not found (${id}). Use a task UUID from task-list or a prior task-create, or omit the field.`;
}

export function contactNotFoundError(id: string): string {
  return `waiting_on_contact_id: contact not found (${id}). Use a contact UUID, or omit the field.`;
}

function taskReferenceError(field: string): string {
  return `${field}: task not found. Use a task UUID from task-list or a prior task-create, or omit the field.`;
}

/** A Postgres FK violation, rewritten so the model never sees the constraint name. */
export function foreignKeyReferenceError(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  if ((err as { code?: unknown }).code !== '23503') return null;
  const constraint = (err as { constraint?: unknown }).constraint;
  const name = typeof constraint === 'string' ? constraint : '';
  if (name.includes('contact')) {
    return 'waiting_on_contact_id: contact not found. Use a contact UUID, or omit the field.';
  }
  if (name.includes('parent_task')) return taskReferenceError('parent_task_id');
  if (name.includes('blocked_by')) return taskReferenceError('blocked_by_task_id');
  return 'task not found. Use a task UUID from task-list or a prior task-create, or omit the field.';
}
