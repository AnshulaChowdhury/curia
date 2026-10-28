// Optional task and contact ids on task-create and task-update (#2328).
//
// Models fill an optional id with "null", "none", "", or a word. Postgres then
// rejects the write with a raw uuid error, and the retry invents an id to get
// past it. Null-like placeholders are omitted. Anything else that is not a UUID
// is rejected with a message that says to omit the field.

import {
  isUnresolvedPlaceholder,
  unresolvedPlaceholderError,
} from '../../src/skills/_shared/placeholder-guard.js';
import { isUuid } from '../../src/util/uuid.js';

const NULLISH_ID = new Set(['null', 'none', 'undefined']);

export const BLOCKED_BY_TASK_ID_ERROR =
  'blocked_by_task_id must be a task UUID from task-list or a prior task-create; omit it if the task is not blocked';

export const PARENT_TASK_ID_ERROR =
  'parent_task_id must be a task UUID from task-list or a prior task-create; omit it if the task has no parent';

export const WAITING_ON_CONTACT_ID_ERROR =
  'waiting_on_contact_id must be a contact UUID; omit it if the task is not waiting on a person';

export type ResolvedOptionalId =
  | { ok: true; id: string | undefined }
  | { ok: false; error: string };

/**
 * Normalize one optional id.
 *
 * `null`, `undefined`, blank, and the words null/none/undefined (any case) are
 * omitted. Set `contactPlaceholder` for a contact id so a copied `${...}` token
 * gets the contact-specific placeholder error. A task id keeps `invalidError`:
 * the placeholder error would tell the model to paste the principal's contact id.
 */
export function resolveOptionalId(
  field: string,
  raw: unknown,
  invalidError: string,
  options?: { contactPlaceholder?: boolean },
): ResolvedOptionalId {
  if (raw === undefined || raw === null) return { ok: true, id: undefined };
  if (typeof raw !== 'string') return { ok: false, error: invalidError };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || NULLISH_ID.has(trimmed.toLowerCase())) {
    return { ok: true, id: undefined };
  }
  if (options?.contactPlaceholder && isUnresolvedPlaceholder(trimmed)) {
    return { ok: false, error: unresolvedPlaceholderError(field, trimmed) };
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

/** A Postgres FK violation, rewritten so the model never sees the constraint name. */
export function foreignKeyReferenceError(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  if ((err as { code?: unknown }).code !== '23503') return null;
  const constraint = (err as { constraint?: unknown }).constraint;
  if (typeof constraint === 'string' && constraint.includes('contact')) {
    return 'waiting_on_contact_id: contact not found. Use a contact UUID, or omit the field.';
  }
  return 'task not found. Use a task UUID from task-list or a prior task-create, or omit the field.';
}
