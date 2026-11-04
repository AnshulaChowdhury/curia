// books-service-client.ts — Curia's side of the books service (the Python pipeline, reached over Railway's private network).
//
// The service keeps nothing between calls and holds no secrets but its own token. Curia sends it the new files, the
// pipeline state from the last call and, when asked, the QuickBooks lines; it gets back the report, the batch, the next
// state and, for lines no rule covers, the prompts for a model. Bank text never goes into an error message or a log line.

import type { Logger } from '../logger.js';

export type ServiceFailure = 'not_configured' | 'unreachable' | 'unauthorised' | 'rejected' | 'failed';

export class BooksServiceError extends Error {
  constructor(readonly kind: ServiceFailure, message: string) {
    super(message);
    this.name = 'BooksServiceError';
  }
}

export interface PipelineState {
  processed: string[];
  transactions: unknown[];
  closing: Record<string, unknown>;
}

export interface ServiceFile {
  /** Only the extension matters to the service (.qbo, .ofx, .csv). */
  name: string;
  content_b64: string;
}

/** One line already in QuickBooks, in the shape the pipeline compares with the bank's. */
export interface ServiceQboLine {
  id: string;
  date: string;
  amount: string;
  name: string;
  description: string;
  category: string;
  line: number;
  account: string;
}

export type AgentAnswer =
  | { status: 'ok'; raw: string[] }
  | { status: 'deferred'; until?: string }
  | { status: 'error'; error: string };

export interface AgentRequest {
  rows: string[];
  system: string;
  user: string;
  schema: string;
}

export interface RunRequest {
  files: ServiceFile[];
  state: PipelineState | null;
  want_qbo?: boolean;
  qbo_lines?: ServiceQboLine[];
  agent?: AgentAnswer;
}

export interface RunReport {
  status: 'ready' | 'failed' | 'deferred';
  batch_id: string | null;
  file_hashes: string[];
  accounts_received: string[];
  counts: Record<string, number>;
  flags: Array<{ kind: string; message: string }>;
  error: string | null;
  retry_after?: string;
  [k: string]: unknown;
}

export interface BatchRowData {
  id: string;
  amount: string;
  date: string;
  description: string;
  category?: string;
  category_source?: string;
  transfer?: boolean;
  [k: string]: unknown;
}

export type RunResponse =
  | { rules_version: string; need_qbo: { start: string; end: string } }
  | {
      rules_version: string;
      report: RunReport;
      batch: { batch_id: string; revision: number; rows: BatchRowData[] } | null;
      agent_input: Array<{ row: string; account: string; amount: string; description: string }>;
      agent_requests: AgentRequest[];
      state: PipelineState;
    };

export interface ServiceAccountInfo {
  id: string;
  name: string;
  kind: string;
  qbo_account: string;
}

export interface BooksServicePort {
  run(request: RunRequest): Promise<RunResponse>;
  accounts(): Promise<ServiceAccountInfo[]>;
}

const TIMEOUT_MS = 120_000;

export class BooksServiceClient implements BooksServicePort {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(new URL(path, this.baseUrl), {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn({ err, path }, 'books service: not reachable');
      throw new BooksServiceError('unreachable', 'The books service could not be reached');
    }
    if (res.status === 401) throw new BooksServiceError('unauthorised', 'The books service refused Curia\'s token');
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      this.logger.warn({ path, status: res.status }, 'books service: reply was not JSON');
      throw new BooksServiceError('failed', `The books service answered ${res.status} with something unreadable`);
    }
    if (res.status >= 400 && res.status < 500) {
      const reason = typeof (parsed as { error?: unknown })?.error === 'string' ? (parsed as { error: string }).error : 'bad request';
      throw new BooksServiceError('rejected', `The books service rejected the request: ${reason}`);
    }
    if (!res.ok) throw new BooksServiceError('failed', `The books service failed (${res.status})`);
    return parsed;
  }

  async run(request: RunRequest): Promise<RunResponse> {
    const out = (await this.call('POST', '/v1/run', request)) as RunResponse;
    if (!('need_qbo' in out) && !('report' in out)) throw new BooksServiceError('failed', 'The books service answered something unexpected');
    return out;
  }

  async accounts(): Promise<ServiceAccountInfo[]> {
    const out = (await this.call('GET', '/v1/accounts')) as { accounts?: ServiceAccountInfo[] };
    if (!Array.isArray(out.accounts)) throw new BooksServiceError('failed', 'The books service answered something unexpected');
    return out.accounts;
  }
}

/** The client from the environment, or null when the service is not set up (Railway sets both on curia-api). */
export function booksServiceFromEnv(env: NodeJS.ProcessEnv, logger: Logger): BooksServiceClient | null {
  const url = env['BOOKS_SERVICE_URL'];
  const token = env['BOOKS_SERVICE_TOKEN'];
  if (!url || !token) return null;
  return new BooksServiceClient(url, token, logger);
}
