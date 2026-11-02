// job-run-history.ts — what a scheduled job did on each run, read from the audit log.
//
// Nothing new is recorded. Every run of a job gets its own conversation id, `scheduler:<jobId>:<runId>`
// (scheduler.ts, fireJob), and the audit log already holds the steps under it: the task, each LLM call, each tool call
// with its input and result, and the final response. This module groups and shapes those rows for the Jobs page.
//
// It is read-only. Values are redacted and capped before they leave (see `scrub`): the audit log keeps what skills were
// given and returned, and a secret-looking field must not travel to the browser even though it is the owner's browser.

import type { Pool } from 'pg';
import { isUuid } from '../util/uuid.js';

/** Most runs one request returns. */
export const MAX_RUNS = 50;
/** Most audit rows read for one run. A run that exceeds it is flagged as cut off. */
export const MAX_STEP_ROWS = 1000;

export type RunOutcome = 'completed' | 'failed' | 'incomplete';

export interface JobRunSummary {
  runId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: RunOutcome;
  toolCalls: number;
  toolFailures: number;
  llmCalls: number;
  errors: number;
  costUsd: number;
}

export interface StepCode {
  label: string;
  value: string;
  /** True when the value is inferred from an error type, not read from the API's own response. */
  inferred?: boolean;
}

export type StepKind = 'task' | 'llm' | 'tool' | 'response' | 'error' | 'blocked';

export interface RunStep {
  id: string;
  at: string;
  /** Milliseconds after the run's first event. */
  offsetMs: number;
  kind: StepKind;
  title: string;
  status: 'ok' | 'error' | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  codes: StepCode[];
}

export interface JobRunDetail extends JobRunSummary {
  steps: RunStep[];
  /** True when the run had more audit rows than MAX_STEP_ROWS and the end is missing. */
  cutOff: boolean;
}

interface AuditRow {
  id: string;
  timestamp: Date;
  event_type: string;
  payload: Record<string, unknown>;
  parent_event_id: string | null;
}

// -- scrubbing ------------------------------------------------------------------------------------------------------

const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|cookie|credential/i;
// Token counts from model calls are numbers, not credentials.
const COUNT_KEY = /^(input|output|total|cache\w*)tokens$/i;
const MAX_STRING = 4000;
const MAX_ITEMS = 50;
const MAX_DEPTH = 8;
const MAX_JSON = 16 * 1024;

/** Copies a value with secret-looking fields blanked and long strings, long lists and deep nesting cut. */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} more characters]` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[nested too deeply]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => scrub(v, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[${value.length - MAX_ITEMS} more items]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && !COUNT_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

/** scrub(), then replace anything still over MAX_JSON with a preview so one step cannot flood the page. */
export function shape(value: unknown): unknown {
  const cleaned = scrub(value);
  const text = JSON.stringify(cleaned) ?? '';
  return text.length > MAX_JSON ? { truncated: true, preview: `${text.slice(0, MAX_STRING)}…` } : cleaned;
}

// -- API codes ------------------------------------------------------------------------------------------------------

// What an agent-side error type usually means on the wire. Shown as inferred: the audit row records the type, not the
// provider's own response.
const TYPICAL_HTTP: Record<string, string> = {
  AUTH_FAILURE: '401 or 403',
  RATE_LIMIT: '429',
  NOT_FOUND: '404',
  VALIDATION_ERROR: '400 or 422',
  PROVIDER_ERROR: '5xx',
  TIMEOUT: 'no response (timeout)',
};

const HTTP_IN_TEXT = /\b(?:HTTP|status(?: code)?|code)[\s:=]+([1-5]\d{2})\b/gi;
const STATUS_KEYS = new Set(['status', 'statuscode', 'status_code', 'httpstatus', 'http_status', 'code']);

/** Numeric HTTP-looking codes a tool result or error message states itself. */
export function httpCodesIn(value: unknown, depth = 0): string[] {
  const found = new Set<string>();
  if (typeof value === 'string') {
    for (const m of value.matchAll(HTTP_IN_TEXT)) found.add(m[1]!);
  } else if (value && typeof value === 'object' && depth < 4) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STATUS_KEYS.has(k.toLowerCase()) && typeof v === 'number' && v >= 100 && v <= 599) found.add(String(v));
      else for (const c of httpCodesIn(v, depth + 1)) found.add(c);
    }
  }
  return [...found];
}

function codesFor(errorType: unknown, evidence: unknown[]): StepCode[] {
  const codes: StepCode[] = [];
  if (typeof errorType === 'string' && errorType) {
    codes.push({ label: 'error type', value: errorType });
    const typical = TYPICAL_HTTP[errorType];
    if (typical) codes.push({ label: 'usually', value: `HTTP ${typical}`, inferred: true });
  }
  const seen = new Set<string>();
  for (const e of evidence) for (const c of httpCodesIn(e)) seen.add(c);
  for (const c of seen) codes.push({ label: 'HTTP', value: c });
  return codes;
}

// -- shaping --------------------------------------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Turns a run's audit rows into steps: a tool call and its result become one step. */
export function buildSteps(rows: AuditRow[]): RunStep[] {
  const startedAt = rows[0]?.timestamp.getTime() ?? 0;
  const steps: RunStep[] = [];
  const toolByInvoke = new Map<string, RunStep>();
  const base = (r: AuditRow) => ({ id: r.id, at: r.timestamp.toISOString(), offsetMs: r.timestamp.getTime() - startedAt });

  for (const r of rows) {
    const p = r.payload;
    switch (r.event_type) {
      case 'agent.task':
        steps.push({ ...base(r), kind: 'task', title: 'Task given to the agent', status: null, durationMs: null,
          input: shape(p['content']), output: null, codes: [] });
        break;
      case 'llm.call':
        steps.push({ ...base(r), kind: 'llm', title: `Model call: ${str(p['actualModel']) || str(p['requestedModel'])}`,
          status: 'ok', durationMs: num(p['latencyMs']), input: null,
          output: shape({ provider: p['provider'], inputTokens: p['inputTokens'], outputTokens: p['outputTokens'],
            cacheReadInputTokens: p['cacheReadInputTokens'], estimatedCostUsd: p['estimatedCostUsd'] }),
          codes: str(p['providerRequestId']) ? [{ label: 'provider request', value: str(p['providerRequestId']) }] : [] });
        break;
      case 'llm.error':
        steps.push({ ...base(r), kind: 'llm', title: `Model call failed: ${str(p['requestedModel'])}`, status: 'error',
          durationMs: null, input: null, output: shape({ provider: p['provider'], errorType: p['errorType'] }),
          codes: codesFor(p['errorType'], []) });
        break;
      case 'tool.invoke': {
        const step: RunStep = { ...base(r), kind: 'tool', title: str(p['toolName']) || 'tool', status: null, durationMs: null,
          input: shape(p['input']), output: null, codes: [] };
        steps.push(step);
        toolByInvoke.set(r.id, step);
        break;
      }
      case 'tool.result': {
        const result = (p['result'] ?? {}) as { success?: boolean; data?: unknown; error?: unknown; errorType?: unknown };
        const ok = result.success === true;
        const output = ok ? result.data : { error: result.error };
        const paired = r.parent_event_id ? toolByInvoke.get(r.parent_event_id) : undefined;
        const patch = { status: ok ? 'ok' as const : 'error' as const, durationMs: num(p['durationMs']),
          output: shape(output), codes: codesFor(result.errorType, [result.error, ok ? result.data : null]) };
        if (paired) Object.assign(paired, patch);
        else steps.push({ ...base(r), kind: 'tool', title: str(p['toolName']) || 'tool', input: null, ...patch });
        break;
      }
      case 'agent.response': {
        const failed = p['isError'] === true;
        steps.push({ ...base(r), kind: 'response', title: failed ? 'Agent finished with an error' : 'Agent finished',
          status: failed ? 'error' : 'ok', durationMs: null, input: null, output: shape(p['content']),
          codes: failed ? codesFor(p['errorType'], [p['content']]) : [] });
        break;
      }
      case 'agent.error':
        steps.push({ ...base(r), kind: 'error', title: 'Agent error', status: 'error', durationMs: null, input: null,
          output: shape(p), codes: codesFor((p['error'] as { type?: unknown } | undefined)?.type ?? p['errorType'], [p]) });
        break;
      case 'autonomy.tool_blocked':
        steps.push({ ...base(r), kind: 'blocked', title: `Blocked: ${str(p['toolName']) || 'tool'}`, status: 'error',
          durationMs: null, input: null, output: shape(p), codes: [] });
        break;
      default:
        break;     // other events in the conversation (memory, routing) are not steps a person reads
    }
  }
  return steps;
}

function outcomeOf(responses: number, errorResponses: number, errors: number): RunOutcome {
  if (errorResponses > 0) return 'failed';
  if (responses > 0) return 'completed';
  return errors > 0 ? 'failed' : 'incomplete';
}

// -- queries --------------------------------------------------------------------------------------------------------

export class JobRunHistory {
  constructor(private readonly pool: Pool) {}

  /** The most recent runs of a job, newest first. */
  async list(jobId: string, limit = 20): Promise<JobRunSummary[]> {
    if (!isUuid(jobId)) return [];
    const prefix = `scheduler:${jobId}:`;
    const { rows } = await this.pool.query<{
      conversation_id: string; started_at: Date; ended_at: Date; tool_calls: string; tool_failures: string; llm_calls: string;
      errors: string; responses: string; error_responses: string; cost_usd: string;
    }>(
      `SELECT conversation_id,
              min(timestamp) AS started_at,
              max(timestamp) AS ended_at,
              count(*) FILTER (WHERE event_type = 'tool.invoke') AS tool_calls,
              count(*) FILTER (WHERE event_type = 'tool.result' AND payload->'result'->>'success' = 'false') AS tool_failures,
              count(*) FILTER (WHERE event_type = 'llm.call') AS llm_calls,
              count(*) FILTER (WHERE event_type IN ('llm.error', 'agent.error')) AS errors,
              count(*) FILTER (WHERE event_type = 'agent.response') AS responses,
              count(*) FILTER (WHERE event_type = 'agent.response' AND payload->>'isError' = 'true') AS error_responses,
              coalesce(sum((payload->>'estimatedCostUsd')::numeric) FILTER (WHERE event_type = 'llm.call'), 0) AS cost_usd
         FROM audit_log
        WHERE conversation_id LIKE $1
        GROUP BY conversation_id
        ORDER BY min(timestamp) DESC
        LIMIT $2`,
      [`${prefix}%`, Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), MAX_RUNS) : 20],
    );
    return rows.map((r) => ({
      runId: r.conversation_id.slice(prefix.length),
      startedAt: r.started_at.toISOString(),
      endedAt: r.ended_at.toISOString(),
      durationMs: r.ended_at.getTime() - r.started_at.getTime(),
      outcome: outcomeOf(Number(r.responses), Number(r.error_responses), Number(r.errors)),
      toolCalls: Number(r.tool_calls),
      toolFailures: Number(r.tool_failures),
      llmCalls: Number(r.llm_calls),
      errors: Number(r.errors),
      costUsd: Number(r.cost_usd),
    }));
  }

  /** One run with every step, or null when there is no such run for this job. */
  async get(jobId: string, runId: string): Promise<JobRunDetail | null> {
    if (!isUuid(jobId) || !isUuid(runId)) return null;
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT id, timestamp, event_type, payload, parent_event_id
         FROM audit_log
        WHERE conversation_id = $1
        ORDER BY timestamp, seq
        LIMIT $2`,
      [`scheduler:${jobId}:${runId}`, MAX_STEP_ROWS + 1],
    );
    if (rows.length === 0) return null;
    const cutOff = rows.length > MAX_STEP_ROWS;
    const used = cutOff ? rows.slice(0, MAX_STEP_ROWS) : rows;
    const steps = buildSteps(used);
    const count = (t: string) => used.filter((r) => r.event_type === t).length;
    const first = used[0]!.timestamp;
    const last = used[used.length - 1]!.timestamp;
    const toolFailures = used.filter((r) => r.event_type === 'tool.result' && (r.payload['result'] as { success?: boolean } | undefined)?.success === false).length;
    const errors = count('llm.error') + count('agent.error');
    const errorResponses = used.filter((r) => r.event_type === 'agent.response' && r.payload['isError'] === true).length;
    return {
      runId,
      startedAt: first.toISOString(),
      endedAt: last.toISOString(),
      durationMs: last.getTime() - first.getTime(),
      outcome: outcomeOf(count('agent.response'), errorResponses, errors),
      toolCalls: count('tool.invoke'),
      toolFailures,
      llmCalls: count('llm.call'),
      errors,
      costUsd: used.filter((r) => r.event_type === 'llm.call').reduce((s, r) => s + (num(r.payload['estimatedCostUsd']) ?? 0), 0),
      steps,
      cutOff,
    };
  }
}
