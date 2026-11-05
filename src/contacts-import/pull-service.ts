// pull-service.ts — "Preview" and "Apply" for the Contacts page.
//
//   preview()  reads every source that is ready, merges duplicates, plans the whole thing as a dry run, and keeps the
//              people it planned for. It writes no contacts. The answer is counts and a small masked sample.
//   apply(id)  applies that exact preview, once. The import service refuses any batch whose people differ from the
//              reviewed plan, and re-checks every person against the contacts as they are now.
//
// A preview older than 24 hours cannot be applied: the contacts may have changed too much to trust it.

import { randomBytes } from 'node:crypto';
import type { Logger } from '../logger.js';
import { ImportError, MAX_PEOPLE_PER_BATCH, type ContactImportService, type ImportPerson, type ReviewReason } from './import-service.js';
import { mergeCandidates, type Candidate } from './merge.js';
import { maskAddress } from './sources.js';
import type { RunStore } from './run-store.js';

export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export interface Collector {
  /** Matches the Sources drawer, e.g. "bridge:whatsapp". */
  sourceId: string;
  label: string;
  collect(): Promise<{ ok: boolean; message: string; read: number; candidates: Candidate[] }>;
}

export interface SampleRow { name: string; identifier: string }

export interface PreviewResult {
  runId: string;
  createdAt: string;
  totals: { people: number; create: number; attach: number; review: number };
  reviewReasons: Partial<Record<ReviewReason, number>>;
  sources: { sourceId: string; label: string; ok: boolean; message: string; read: number; usable: number }[];
  /** Entries dropped because they had no name that identifies a person (only a number or an address). */
  droppedNoName: number;
  sample: { create: SampleRow[]; attach: SampleRow[]; review: SampleRow[] };
}

export interface ApplyTotals { created: number; attached: number; skipped: number; failed: number }

export class PullError extends Error {
  constructor(public readonly code: 'unknown_run' | 'preview_expired' | 'nothing_to_import', message: string) {
    super(message);
    this.name = 'PullError';
  }
}

const SAMPLE_SIZE = 5;

/** `+14165550142` → `+1•••••••42`; an email → `d***@example.org`. Only enough to recognise a person. */
function maskIdentifier(p: ImportPerson): string {
  const phone = p.phones?.[0];
  if (phone) return `${phone.slice(0, 2)}${'•'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-2)}`;
  return maskAddress(p.emails?.[0]) ?? '';
}

export class ContactsPullService {
  constructor(
    private readonly importer: ContactImportService,
    private readonly runs: RunStore,
    private readonly collectors: Collector[],
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async preview(): Promise<PreviewResult> {
    const sources: PreviewResult['sources'] = [];
    const all: Candidate[] = [];
    for (const c of this.collectors) {
      // One source failing must not stop the others.
      try {
        const r = await c.collect();
        sources.push({ sourceId: c.sourceId, label: c.label, ok: r.ok, message: r.message, read: r.read, usable: r.candidates.length });
        all.push(...r.candidates);
      } catch (err) {
        this.logger.error({ sourceId: c.sourceId, errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-import: a source failed');
        sources.push({ sourceId: c.sourceId, label: c.label, ok: false, message: 'This source failed; see the server log.', read: 0, usable: 0 });
      }
    }

    const { people, noName } = mergeCandidates(all);
    if (people.length === 0) {
      throw new PullError('nothing_to_import', 'No people were found in the connected sources.');
    }

    const runId = `pull-${this.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const totals = { people: people.length, create: 0, attach: 0, review: 0 };
    const reviewReasons: PreviewResult['reviewReasons'] = {};
    const sample: PreviewResult['sample'] = { create: [], attach: [], review: [] };

    for (let start = 0, n = 1; start < people.length; start += MAX_PEOPLE_PER_BATCH, n += 1) {
      const chunk = people.slice(start, start + MAX_PEOPLE_PER_BATCH).map((m) => m.person);
      const batchId = `${runId}-${n}`;
      const plan = await this.importer.plan(batchId, chunk);
      await this.runs.savePayload(runId, batchId, chunk);
      plan.items.forEach((item, i) => {
        const p = chunk[i]!;
        totals[item.action] += 1;
        if (item.action === 'review') reviewReasons[item.reason] = (reviewReasons[item.reason] ?? 0) + 1;
        const bucket = sample[item.action];
        if (bucket.length < SAMPLE_SIZE) bucket.push({ name: p.displayName, identifier: maskIdentifier(p) });
      });
    }

    this.logger.info({ runId, ...totals, droppedNoName: noName }, 'contacts-import: preview ready');
    return { runId, createdAt: new Date(this.now()).toISOString(), totals, reviewReasons, sources, droppedNoName: noName, sample };
  }

  async apply(runId: string): Promise<{ runId: string; totals: ApplyTotals }> {
    const chunks = await this.runs.getRun(runId);
    if (chunks.length === 0) throw new PullError('unknown_run', 'Run a preview first. This one was not found or was already applied.');
    const oldest = Math.min(...chunks.map((c) => Date.parse(c.createdAt)));
    if (this.now() - oldest > PREVIEW_TTL_MS) {
      await this.runs.deleteRun(runId);
      throw new PullError('preview_expired', 'That preview is more than 24 hours old. Run a new preview.');
    }

    const totals: ApplyTotals = { created: 0, attached: 0, skipped: 0, failed: 0 };
    for (const chunk of chunks) {
      try {
        const result = await this.importer.apply(chunk.batchId, chunk.people);
        totals.created += result.counts.created;
        totals.attached += result.counts.attached;
        totals.skipped += result.counts.skipped;
        totals.failed += result.counts.failed;
      } catch (err) {
        // A batch that was already applied (a retry after a partial failure) is done; any other error counts the
        // batch as failed and the rest still run.
        if (err instanceof ImportError && err.code === 'already_applied') continue;
        this.logger.error({ runId, batchId: chunk.batchId, errorName: err instanceof Error ? err.name : 'unknown' }, 'contacts-import: a batch could not be applied');
        totals.failed += chunk.people.length;
      }
    }
    // Keep the people only while a retry could still need them: when nothing failed, drop them.
    if (totals.failed === 0) await this.runs.deleteRun(runId);
    this.logger.info({ runId, ...totals }, 'contacts-import: run applied');
    return { runId, totals };
  }
}
