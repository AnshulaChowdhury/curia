// books-runner.ts — one books run, driven by Curia: bank files in, a batch for review out.
//
// Replaces the run the Mac mini used to make. Curia lists the waiting files (Books page uploads and the Drive folder),
// hands them to the books service with the state from the last run, reads QuickBooks when the service asks for it,
// asks a model about the lines no rule covers (the service supplies the prompt and checks the answer), and stores the
// batch for the owner to review. Files are marked processed only after the batch is stored, so a failed run repeats.
//
// The model sees nothing but the prompts the service built: no tools, no other context (ADR-060, books specialist).

import type { Logger } from '../logger.js';
import type { InfraLlmResult, InfraLlmExtractOptions } from '../skills/infra-llm.js';
import type { BatchStore } from './batch-store.js';
import { validatePush } from './batch-store.js';
import {
  BooksServiceError,
  type AgentAnswer,
  type AgentRequest,
  type BooksServicePort,
  type RunReport,
  type RunRequest,
  type RunResponse,
  type ServiceFile,
} from './books-service-client.js';
import type { BooksMonitor } from './monitor.js';
import type { MonitorStore, RunStatus } from './monitor-store.js';
import type { QboQueryPort } from './qbo-balances.js';
import { loadQboLines } from './qbo-lines.js';
import type { PipelineStateStore } from './pipeline-state-store.js';
import type { UploadStore } from './upload-store.js';
import type { DriveInbox } from './drive-inbox.js';
import { DriveSettingsError } from './drive-inbox.js';

export const TICK_MS = 5 * 60_000;
/** After a failed run the scheduled check waits this long, so a persistent fault is announced once, not every tick. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
const FIRST_TICK_MS = 90_000;
const MODEL_MAX_TOKENS = 8000;
const EXTENSION = /\.(qbo|ofx|csv)$/i;

export interface RunnerDeps {
  service: BooksServicePort;
  state: Pick<PipelineStateStore, 'load' | 'save'>;
  uploads: Pick<UploadStore, 'listWaiting' | 'read' | 'markProcessed'>;
  drive: Pick<DriveInbox, 'list' | 'read' | 'markProcessed'>;
  batches: Pick<BatchStore, 'upsertBatch'>;
  monitorStore: Pick<MonitorStore, 'recordRun' | 'recordHeartbeat'>;
  monitor: Pick<BooksMonitor, 'onRunReported'>;
  /** The shared QuickBooks connection; null when QuickBooks is not set up. */
  qbo: QboQueryPort | null;
  llm: { extract(prompt: string, options?: InfraLlmExtractOptions): Promise<InfraLlmResult> };
  logger: Logger;
  now?: () => Date;
}

export type RunOutcome =
  | { outcome: 'nothing_waiting' }
  | { outcome: 'already_running' }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'ready'; batchId: string | null; rows: number; byRule: number; guesses: number; needsInput: number; flags: number; files: number };

interface Waiting {
  source: 'upload' | 'drive';
  id: string;
}

export class BooksRunner {
  private running = false;
  private failedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RunnerDeps) {}

  /** Looks for waiting files every few minutes, like the Mac mini's check did. Idle when there are none. */
  start(): void {
    if (this.timer) return;
    const tick = (): void => void this.runOnce('schedule').catch((err: unknown) => this.deps.logger.error({ err }, 'books: the scheduled check failed'));
    this.first = setTimeout(tick, FIRST_TICK_MS);
    this.timer = setInterval(tick, TICK_MS);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  async runOnce(trigger: 'schedule' | 'manual'): Promise<RunOutcome> {
    if (this.running) return { outcome: 'already_running' };
    if (trigger === 'schedule' && this.failedAt !== null && this.now().getTime() - this.failedAt < RETRY_AFTER_FAILURE_MS) {
      return { outcome: 'nothing_waiting' };
    }
    this.running = true;
    const { logger, monitorStore } = this.deps;
    try {
      await monitorStore.recordHeartbeat({ state: 'running', version: 'in-curia', lastRunAt: null });
      const result = await this.run(trigger);
      this.failedAt = result.outcome === 'failed' ? this.now().getTime() : null;
      await monitorStore.recordHeartbeat({ state: 'idle', version: 'in-curia', lastRunAt: this.now() });
      return result;
    } catch (err) {
      // Whatever went wrong, the files stay where they are and the next check repeats the run.
      logger.error({ err }, 'books: run crashed');
      this.failedAt = this.now().getTime();
      await this.fail(err instanceof BooksServiceError ? err.message : 'The books run stopped unexpectedly; the files are still waiting', []);
      return { outcome: 'failed', reason: err instanceof BooksServiceError ? err.message : 'The books run stopped unexpectedly' };
    } finally {
      this.running = false;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async waiting(): Promise<Waiting[]> {
    const out: Waiting[] = (await this.deps.uploads.listWaiting()).map(f => ({ source: 'upload', id: f.id }));
    try {
      out.push(...(await this.deps.drive.list()).map(f => ({ source: 'drive' as const, id: f.id })));
    } catch (err) {
      if (!(err instanceof DriveSettingsError)) this.deps.logger.warn({ err }, 'books: Google Drive folder unavailable; using uploads only');
    }
    return out;
  }

  private async read(w: Waiting): Promise<{ name: string; bytes: Buffer } | null> {
    return w.source === 'upload' ? this.deps.uploads.read(w.id) : this.deps.drive.read(w.id);
  }

  private async run(trigger: string): Promise<RunOutcome> {
    const { service, state, logger } = this.deps;
    const waiting = await this.waiting();
    if (waiting.length === 0) return { outcome: 'nothing_waiting' };

    // Read every file first. A name from a bank or a person never reaches the service: only the kind of file does.
    const taken: Waiting[] = [];
    const files: ServiceFile[] = [];
    for (const w of waiting) {
      const f = await this.read(w);
      const ext = f && EXTENSION.exec(f.name)?.[1]?.toLowerCase();
      if (!f || !ext) continue;
      taken.push(w);
      files.push({ name: `file-${taken.length}.${ext}`, content_b64: f.bytes.toString('base64') });
    }
    if (files.length === 0) return { outcome: 'nothing_waiting' };

    const request: RunRequest = { files, state: await state.load(), want_qbo: this.deps.qbo !== null };
    let res = await service.run(request);

    if ('need_qbo' in res) {
      if (!this.deps.qbo) throw new BooksServiceError('failed', 'The books service asked for QuickBooks, which is not set up');
      let lines;
      try {
        lines = await loadQboLines(this.deps.qbo, await service.accounts(), res.need_qbo);
      } catch (err) {
        // Nothing may be posted without knowing what is already booked, so a run that cannot read QuickBooks stops here.
        logger.warn({ err }, 'books: could not read QuickBooks for the run');
        return this.fail('Could not read QuickBooks, so the run was stopped: check the QuickBooks connection', taken);
      }
      request.qbo_lines = lines;
      res = await service.run(request);
    }
    if ('need_qbo' in res) throw new BooksServiceError('failed', 'The books service asked for QuickBooks twice');

    if (res.agent_requests.length > 0) {
      request.agent = await this.askModel(res.agent_requests);
      res = await service.run(request);
      if ('need_qbo' in res) throw new BooksServiceError('failed', 'The books service asked for QuickBooks twice');
    }

    return this.commit(res, taken, trigger);
  }

  /** One model call per request, in order. Any failure leaves those lines as "needs input": the run still completes. */
  private async askModel(requests: AgentRequest[]): Promise<AgentAnswer> {
    const raw: string[] = [];
    for (const r of requests) {
      const prompt = `${r.system}\n\nAnswer with only a JSON object that follows this JSON schema:\n${r.schema}\n\nThe user message follows.\n\n${r.user}`;
      const out = await this.deps.llm.extract(prompt, { maxTokens: MODEL_MAX_TOKENS, tier: 'standard' });
      if (!out.ok) {
        this.deps.logger.warn({ error: out.error.slice(0, 200) }, 'books: the model call failed; those lines stay "needs input"');
        return { status: 'error', error: 'the model could not be reached' };
      }
      raw.push(out.text);
    }
    return { status: 'ok', raw };
  }

  private async commit(res: Extract<RunResponse, { report: RunReport }>, taken: Waiting[], trigger: string): Promise<RunOutcome> {
    const { report, batch } = res;
    const { logger } = this.deps;
    if (report.status !== 'ready') return this.fail(report.error ?? 'The run did not complete', taken, report);

    let rows = 0;
    if (batch && report.batch_id) {
      const valid = validatePush(report.batch_id, batch.rows, report);
      rows = await this.deps.batches.upsertBatch(valid.batchId, valid.report, valid.rows);
    }
    await this.deps.state.save(res.state);
    await Promise.all(taken.map(w => (w.source === 'upload' ? this.deps.uploads.markProcessed(w.id) : this.deps.drive.markProcessed(w.id))));

    const run = {
      status: 'ready' as RunStatus,
      batchId: report.batch_id,
      accountsReceived: report.accounts_received,
      expectedAccounts: (await this.deps.service.accounts()).map(a => a.id),
      files: taken.map((_, i) => `file-${i + 1}`),
      report: { ...report, trigger },
    };
    await this.deps.monitorStore.recordRun(run);
    const c = report.counts;
    logger.info({ batchId: report.batch_id, rows, files: taken.length, trigger }, 'books: run complete');
    return { outcome: 'ready', batchId: report.batch_id, rows, byRule: c['by_rule'] ?? 0, guesses: c['guesses'] ?? 0, needsInput: c['needs_input'] ?? 0, flags: c['flags'] ?? 0, files: taken.length };
  }

  private async fail(reason: string, taken: Waiting[], report?: RunReport): Promise<RunOutcome> {
    const run = {
      status: 'failed' as RunStatus,
      batchId: null,
      accountsReceived: [],
      expectedAccounts: [],
      files: taken.map((_, i) => `file-${i + 1}`),
      report: { ...(report ?? {}), status: 'failed', error: reason },
    };
    await this.deps.monitorStore.recordRun(run);
    await this.deps.monitor.onRunReported(run).catch((err: unknown) => this.deps.logger.error({ err }, 'books: could not announce a failed run'));
    return { outcome: 'failed', reason };
  }
}
