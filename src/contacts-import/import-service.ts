// import-service.ts — brings people from outside lists (bridge contact lists, address books) into Curia's contacts.
//
// Two steps, so nothing is written that was not reviewed:
//   plan()  — a dry run: for each person, say whether they would be created, matched to an existing contact, or sent
//             to a person to review. Writes only the plan.
//   apply() — does exactly what the saved plan says, once, for the same people. Everything is checked again first;
//             anything that changed since the dry run is skipped, not guessed.
//
// Safety rules (contacts-import design, section 4). They are the point of this file:
//   1. A new contact is tier `unknown`, passed explicitly: createContact's own default is `known`, which is right for
//      contacts the principal adds and wrong for a bulk import. This service never changes the tier of an existing
//      contact, and never sets a role, permission or system role.
//   2. Identifiers are linked with source `bulk_import`, which is never auto-verified, and `verified` is never passed.
//   3. Names go through ContactService.createContact, which sanitises them.
//   4. An identifier that belongs to another contact is never moved: the person goes to review.
//   5. A value already on file is never overwritten; only empty fields are filled. A different value goes to review.
//   6. The principal, agents and system contacts are never touched.
//   7. Nothing is deleted.

import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import { classifyEmailSender, type ContactService } from '../contacts/contact-service.js';
import type { Contact } from '../contacts/types.js';
import { comparableChannels } from '../contacts/identifier-near-miss.js';
import { normalizeEmail, normalizePhone, stableStringify } from './normalize.js';
import type { ImportLabel, ImportStore } from './import-store.js';

export const IMPORT_SOURCE = 'bulk_import' as const;

export const MAX_PEOPLE_PER_BATCH = 500;
const MAX_NAME = 200;
const MAX_FIELD = 200;
const MAX_KEY = 300;
const MAX_IDENTIFIERS = 10;
const LABELS: ReadonlySet<string> = new Set(['work', 'personal', 'hybrid']);

export interface ImportPerson {
  /** Stable id of the record in the outside list, such as "whatsapp:lid-123". Re-sending it updates, never duplicates. */
  sourceKey: string;
  displayName: string;
  organization?: string;
  title?: string;
  emails?: string[];
  phones?: string[];
  suggestedLabel?: ImportLabel;
}

export type ReviewReason =
  | 'invalid_person'
  | 'no_usable_identifier'
  | 'duplicate_in_batch'
  | 'identifiers_span_contacts'
  | 'protected_contact'
  | 'source_key_conflict'
  | 'field_differs'
  | 'changed_since_dry_run';

export type PlanItem =
  | { sourceKey: string; action: 'create' }
  | { sourceKey: string; action: 'attach'; contactId: string }
  | { sourceKey: string; action: 'review'; reason: ReviewReason; contactId?: string };

export interface ImportPlan {
  batchId: string;
  items: PlanItem[];
  counts: { create: number; attach: number; review: number };
}

export interface ApplyOutcome {
  sourceKey: string;
  outcome: 'created' | 'attached' | 'skipped' | 'failed';
  contactId?: string;
  reason?: ReviewReason | 'error';
}

export interface ApplyResult {
  batchId: string;
  outcomes: ApplyOutcome[];
  counts: { created: number; attached: number; skipped: number; failed: number };
}

export class ImportError extends Error {
  constructor(public readonly code: 'too_many_people' | 'bad_batch_id' | 'unknown_batch' | 'already_applied' | 'payload_changed' | 'not_saved', message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

interface Normalized {
  sourceKey: string;
  displayName: string;
  organization: string | null;
  title: string | null;
  emails: string[];
  phones: string[];
  label: ImportLabel | null;
}

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : null;

/** Cleans one person, or says why not. Never throws on bad input: bad people go to review. */
function normalizePerson(p: unknown): Normalized | { invalid: true; sourceKey: string } {
  const o = (p !== null && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const sourceKey = typeof o['sourceKey'] === 'string' ? o['sourceKey'].slice(0, MAX_KEY) : '';
  const displayName = text(o['displayName'], MAX_NAME);
  if (!sourceKey.trim() || !displayName) return { invalid: true, sourceKey };
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, MAX_IDENTIFIERS).filter((x): x is string => typeof x === 'string') : []);
  const emails = [...new Set(list(o['emails']).map(normalizeEmail).filter((x): x is string => x !== null))];
  const phones = [...new Set(list(o['phones']).map(normalizePhone).filter((x): x is string => x !== null))];
  const rawLabel = o['suggestedLabel'];
  return {
    sourceKey,
    displayName,
    organization: text(o['organization'], MAX_FIELD),
    title: text(o['title'], MAX_FIELD),
    emails,
    phones,
    label: typeof rawLabel === 'string' && LABELS.has(rawLabel) ? (rawLabel as ImportLabel) : null,
  };
}

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export class ContactImportService {
  constructor(
    private readonly contacts: ContactService,
    private readonly store: ImportStore,
    private readonly logger: Logger,
  ) {}

  /** Dry run. Saves the plan under `batchId`; writes no contacts. */
  async plan(batchId: string, people: unknown[]): Promise<ImportPlan> {
    this.checkBatch(batchId, people);
    const items = await this.evaluateAll(people);
    const plan: ImportPlan = { batchId, items, counts: countPlan(items) };
    if (!(await this.store.savePlan(batchId, hashPeople(people), plan))) {
      throw new ImportError('already_applied', 'That batch was already applied; use a new batch id.');
    }
    this.logger.info({ batchId, ...plan.counts }, 'contacts-import: dry run planned');
    return plan;
  }

  /** Does what the saved plan says for the same people. Allowed once per batch. */
  async apply(batchId: string, people: unknown[]): Promise<ApplyResult> {
    this.checkBatch(batchId, people);
    const stored = await this.store.getBatch(batchId);
    if (!stored) throw new ImportError('unknown_batch', 'Run a dry run for this batch first.');
    if (stored.status === 'applied') throw new ImportError('already_applied', 'That batch was already applied.');
    if (stored.inputHash !== hashPeople(people)) {
      throw new ImportError('payload_changed', 'These people differ from the dry run that was reviewed; run a new dry run.');
    }
    const planned = (stored.plan as ImportPlan).items;

    // Check everything again now: contacts may have changed since the dry run.
    const normalized = people.map(normalizePerson);
    const fresh = await this.evaluateAll(people);
    const outcomes: ApplyOutcome[] = [];

    for (let i = 0; i < people.length; i += 1) {
      const was = planned[i];
      const now = fresh[i];
      const n = normalized[i];
      if (!was || !now || !n) continue;
      if (was.action === 'review') {
        outcomes.push({ sourceKey: was.sourceKey, outcome: 'skipped', reason: was.reason });
        continue;
      }
      if (now.action !== was.action || (now.action === 'attach' && was.action === 'attach' && now.contactId !== was.contactId)) {
        outcomes.push({ sourceKey: was.sourceKey, outcome: 'skipped', reason: 'changed_since_dry_run' });
        continue;
      }
      if ('invalid' in n) continue; // cannot happen: invalid people are always review items
      try {
        outcomes.push(now.action === 'create' ? await this.create(batchId, n) : await this.attach(batchId, n, (now as { contactId: string }).contactId));
      } catch (err) {
        // One person failing must not stop the rest. Log the kind of error only: it can contain an identifier.
        this.logger.error({ batchId, errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-import: a person could not be applied');
        outcomes.push({ sourceKey: n.sourceKey, outcome: 'failed', reason: 'error' });
      }
    }

    const result: ApplyResult = { batchId, outcomes, counts: countOutcomes(outcomes) };
    if (!(await this.store.markApplied(batchId, result))) {
      throw new ImportError('already_applied', 'That batch was applied by another request.');
    }
    this.logger.info({ batchId, ...result.counts }, 'contacts-import: batch applied');
    return result;
  }

  // ---- evaluation (read-only) ----

  private checkBatch(batchId: string, people: unknown[]): void {
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(batchId)) throw new ImportError('bad_batch_id', 'Batch id must be 1-100 letters, digits or . _ : -');
    if (people.length > MAX_PEOPLE_PER_BATCH) throw new ImportError('too_many_people', `At most ${MAX_PEOPLE_PER_BATCH} people per batch.`);
  }

  private async evaluateAll(people: unknown[]): Promise<PlanItem[]> {
    const claimed = new Set<string>(); // source keys and identifiers already used by an earlier person in this batch
    const items: PlanItem[] = [];
    for (const raw of people) {
      const n = normalizePerson(raw);
      if ('invalid' in n) {
        items.push({ sourceKey: n.sourceKey, action: 'review', reason: 'invalid_person' });
        continue;
      }
      items.push(await this.evaluate(n, claimed));
    }
    return items;
  }

  private async evaluate(n: Normalized, claimed: Set<string>): Promise<PlanItem> {
    const review = (reason: ReviewReason, contactId?: string): PlanItem =>
      ({ sourceKey: n.sourceKey, action: 'review', reason, ...(contactId ? { contactId } : {}) });

    if (n.emails.length === 0 && n.phones.length === 0) return review('no_usable_identifier');

    // The same person twice in one batch, by source key or by any identifier: only the first is considered.
    const keys = [`source:${n.sourceKey}`, ...n.emails.map(e => `email:${e}`), ...n.phones.map(p => `phone:${p}`)];
    if (keys.some(k => claimed.has(k))) return review('duplicate_in_batch');
    for (const k of keys) claimed.add(k);

    // Which existing contacts do these identifiers already belong to?
    const owners = new Set<string>();
    for (const e of n.emails) {
      const r = await this.contacts.resolveByChannelIdentity('email', e);
      if (r) owners.add(r.contactId);
    }
    for (const p of n.phones) {
      for (const channel of comparableChannels('phone')) {
        const r = await this.contacts.resolveByChannelIdentity(channel, p);
        if (r) owners.add(r.contactId);
      }
    }
    if (owners.size > 1) return review('identifiers_span_contacts');

    const mapped = await this.store.getContactIdForSource(n.sourceKey);
    const [owner] = [...owners];
    if (mapped && owner && mapped !== owner) return review('source_key_conflict', owner);
    const target = owner ?? mapped ?? null;
    if (!target) return { sourceKey: n.sourceKey, action: 'create' };

    const contact = await this.contacts.getContact(target);
    if (!contact) return { sourceKey: n.sourceKey, action: 'create' }; // the mapped contact was deleted
    if (isProtected(contact)) return review('protected_contact', target);
    if ((n.organization && contact.organization && !sameText(n.organization, contact.organization))
      || (n.title && contact.title && !sameText(n.title, contact.title))) {
      return review('field_differs', target);
    }
    return { sourceKey: n.sourceKey, action: 'attach', contactId: target };
  }

  // ---- writes (apply only) ----

  private async create(batchId: string, n: Normalized): Promise<ApplyOutcome> {
    const contact = await this.contacts.createContact({
      displayName: n.displayName,
      source: IMPORT_SOURCE,
      ...(n.organization ? { organization: n.organization } : {}),
      ...(n.title ? { title: n.title } : {}),
      // Explicit, because createContact defaults to `known`. An import must never grant more than `unknown`.
      tier: 'unknown',
      // Noreply / newsletter / bulk senders are `automated`, so they stay out of the default contact list.
      ...(n.emails.length > 0 && n.emails.every(e => classifyEmailSender(e) === 'automated') ? { kind: 'automated' as const } : {}),
      ...(n.emails[0] ? { primaryEmail: n.emails[0] } : {}),
      ...(n.phones[0] ? { primaryPhone: n.phones[0] } : {}),
    });
    await this.linkAll(contact.id, n, []);
    await this.finish(batchId, n, contact.id);
    return { sourceKey: n.sourceKey, outcome: 'created', contactId: contact.id };
  }

  private async attach(batchId: string, n: Normalized, contactId: string): Promise<ApplyOutcome> {
    const contact = await this.contacts.getContact(contactId);
    if (!contact || isProtected(contact)) return { sourceKey: n.sourceKey, outcome: 'skipped', reason: 'protected_contact' };
    const existing = await this.contacts.getIdentitiesForContact(contactId);
    await this.linkAll(contactId, n, existing.map(i => `${i.channel}:${i.channelIdentifier}`));
    // Fill only what is empty. updateContactFields leaves absent keys alone.
    const fill: { organization?: string; title?: string } = {};
    if (n.organization && !contact.organization) fill.organization = n.organization;
    if (n.title && !contact.title) fill.title = n.title;
    if (Object.keys(fill).length > 0) await this.contacts.updateContactFields(contactId, fill);
    await this.finish(batchId, n, contactId);
    return { sourceKey: n.sourceKey, outcome: 'attached', contactId };
  }

  private async linkAll(contactId: string, n: Normalized, have: string[]): Promise<void> {
    const haveSet = new Set(have.map(h => h.toLowerCase()));
    for (const email of n.emails) {
      if (haveSet.has(`email:${email}`)) continue;
      // `verified` is never passed: bulk_import is not auto-verified.
      await this.contacts.linkIdentity({ contactId, channel: 'email', channelIdentifier: email, source: IMPORT_SOURCE });
    }
    for (const phone of n.phones) {
      if (comparableChannels('phone').some(c => haveSet.has(`${c}:${phone}`.toLowerCase()))) continue;
      await this.contacts.linkIdentity({ contactId, channel: 'phone', channelIdentifier: phone, source: IMPORT_SOURCE });
    }
  }

  private async finish(batchId: string, n: Normalized, contactId: string): Promise<void> {
    await this.store.recordSource(n.sourceKey, contactId, batchId);
    if (n.label) await this.store.suggestLabel(contactId, n.label);
  }
}

/** The principal, agents and system contacts are never changed by an import. */
function isProtected(c: Contact): boolean {
  return c.systemRole !== null || c.kind === 'principal' || c.kind === 'agent';
}

function hashPeople(people: unknown[]): string {
  return createHash('sha256').update(stableStringify(people)).digest('hex');
}

function countPlan(items: PlanItem[]): ImportPlan['counts'] {
  const c = { create: 0, attach: 0, review: 0 };
  for (const i of items) c[i.action] += 1;
  return c;
}

function countOutcomes(outcomes: ApplyOutcome[]): ApplyResult['counts'] {
  const c = { created: 0, attached: 0, skipped: 0, failed: 0 };
  for (const o of outcomes) c[o.outcome] += 1;
  return c;
}
