// dashboard-utils.ts — pure logic + data-fetching for the operator home.
//
// Everything the dashboard cards need that isn't JSX lives here so it can be
// unit-tested in the node vitest env (no jsdom). Each fetch function is
// independent, so one dead endpoint degrades a single card rather than the
// whole page. Response shapes mirror the backend routes (cited per-type);
// the console has no shared/generated API-types module, so we declare local
// mirrors following the existing per-page convention.

import { apiFetch } from '../../api.js';

// ── Health (mirrors src/health/types.ts HealthResponse + GET /api/health) ─────

export type CheckResult = 'ok' | 'fail' | 'skipped';
export type HealthStatus = 'ok' | 'degraded' | 'down';

// checks is intentionally typed loosely: top-level entries are either a
// CheckResult or a nested object of CheckResults (today only `mcp.*`). Keeping
// it generic means new MCP servers — or any future nested group — flatten into
// pills without a code change.
export interface HealthResponse {
  status: HealthStatus;
  uptime_s: number;
  checks: Record<string, CheckResult | Record<string, CheckResult>>;
}

export interface HealthCheckPill {
  name: string;
  result: CheckResult;
}

// Runtime shape guard — a 503 body is only "data" (a red health card) if it is
// actually health-shaped; anything else is a genuine transport error.
function isCheckResult(v: unknown): v is CheckResult {
  return v === 'ok' || v === 'fail' || v === 'skipped';
}

export function isHealthResponse(body: unknown): body is HealthResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b['status'] !== 'ok' && b['status'] !== 'degraded' && b['status'] !== 'down') return false;
  if (typeof b['uptime_s'] !== 'number') return false;
  if (typeof b['checks'] !== 'object' || b['checks'] === null) return false;
  return true;
}

// Flatten the fixed checks object into a flat pill list, expanding nested
// groups (e.g. `mcp: { google_workspace: 'ok' }` → `mcp.google_workspace`).
export function flattenHealthChecks(checks: HealthResponse['checks']): HealthCheckPill[] {
  const pills: HealthCheckPill[] = [];
  for (const [name, value] of Object.entries(checks)) {
    if (isCheckResult(value)) {
      pills.push({ name, result: value });
    } else if (typeof value === 'object' && value !== null) {
      for (const [sub, subValue] of Object.entries(value)) {
        if (isCheckResult(subValue)) pills.push({ name: `${name}.${sub}`, result: subValue });
      }
    }
  }
  return pills;
}

// Map a per-check result to one of the EXISTING .status-pill modifier classes
// (app.css) — no new health-specific pill classes, per the issue.
//   ok → confirmed (green) · fail → blocked (red) · skipped → neutral (no modifier)
export function healthCheckPillClass(result: CheckResult): string {
  switch (result) {
    case 'ok':      return 'confirmed';
    case 'fail':    return 'blocked';
    case 'skipped': return '';
  }
}

export type HealthTone = 'ok' | 'warn' | 'danger';

export interface HealthStatusMeta {
  label: string;
  tone: HealthTone;
}

// Overall traffic-light status → human label + tone (drives the big dot colour).
export function healthStatusMeta(status: HealthStatus): HealthStatusMeta {
  switch (status) {
    case 'ok':       return { label: 'All systems nominal', tone: 'ok' };
    case 'degraded': return { label: 'Degraded', tone: 'warn' };
    case 'down':     return { label: 'Down', tone: 'danger' };
  }
}

// "6d 14h 22m". uptime_s of -1 (the health route's internal-error sentinel)
// or any negative value renders as "unknown" rather than a nonsense duration.
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const total = Math.floor(seconds);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// GET /api/health — 200 normally, 503 when status==='down'. A 503 with a
// health-shaped JSON body is DATA: the operator must see the red "Down" card,
// not a generic error state. Only a non-health body (or other status) is an error.
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await apiFetch('/api/health', signal ? { signal } : undefined);
  const contentType = res.headers.get('content-type') ?? '';
  const healthShaped503 = res.status === 503 && contentType.includes('application/json');
  if (res.ok || healthShaped503) {
    const body = (await res.json()) as unknown;
    if (isHealthResponse(body)) return body;
    // 2xx/503 but not health-shaped (e.g. an SPA-fallback HTML body parsed as
    // an object, or a schema drift) — real error, just not a transport one.
    throw new Error('health check returned an unexpected response');
  }
  throw new Error(`health check failed: HTTP ${res.status}`);
}

// ── Attention (jobs + channels + email accounts) ──────────────────────────────

// Minimal mirror of the Job shape (src/scheduler; GET /api/jobs).
export interface DashboardJob {
  id: string;
  agentId: string;
  status: string;
}

// Mirror of ChannelEntry (src/registry/channel-registry-types.ts; GET /api/registry/channels).
export interface DashboardChannel {
  name: string;
  state: 'uninstalled' | 'installed' | 'enabled';
  isToggleable: boolean;
}

// Mirror of the email-accounts registry entry (GET /api/registry/email-accounts).
export interface DashboardEmailAccount {
  name: string;
  selfEmail: string;
  hasGrant: boolean;
}

export type AttentionTone = 'warn' | 'danger';
// Deep-link targets are constrained to real routes so <Link to> stays type-safe.
export type AttentionTarget = '/jobs' | '/channels';

export interface AttentionItem {
  key: string;
  title: string;
  detail: string;
  tone: AttentionTone;
  to: AttentionTarget;
}

// Distinct agent ids, joined for a compact detail line. Caps at 3 to avoid an
// unbounded line, appending "+N more" when truncated.
function summariseAgents(jobs: DashboardJob[]): string {
  const ids = [...new Set(jobs.map(j => j.agentId))];
  if (ids.length <= 3) return ids.join(' · ');
  return `${ids.slice(0, 3).join(' · ')} +${ids.length - 3} more`;
}

// Aggregate the four attention sources into a flat, deep-linkable list.
// Empty result → the card renders its green "nothing needs your attention" state.
//
// Channels: we flag toggleable channels that are INSTALLED but not enabled —
// a half-finished setup the operator can complete with one click. Uninstalled
// optional channels are "not started", not "needs attention"; flagging them
// would make a fresh install never reach the clean state.
export function aggregateAttention(input: {
  failedJobs: DashboardJob[];
  suspendedJobs: DashboardJob[];
  channels: DashboardChannel[];
  emailAccounts: DashboardEmailAccount[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (input.failedJobs.length > 0) {
    const n = input.failedJobs.length;
    items.push({
      key: 'jobs-failed',
      title: `${n} job${n === 1 ? '' : 's'} failed`,
      detail: summariseAgents(input.failedJobs) || 'last run failed',
      tone: 'danger',
      to: '/jobs',
    });
  }

  if (input.suspendedJobs.length > 0) {
    const n = input.suspendedJobs.length;
    items.push({
      key: 'jobs-suspended',
      title: `${n} job${n === 1 ? '' : 's'} suspended`,
      detail: summariseAgents(input.suspendedJobs) || 'awaiting action',
      tone: 'warn',
      to: '/jobs',
    });
  }

  for (const ch of input.channels) {
    if (ch.isToggleable && ch.state === 'installed') {
      items.push({
        key: `channel-${ch.name}`,
        title: `${ch.name} channel not enabled`,
        detail: 'Configured but not enabled',
        tone: 'warn',
        to: '/channels',
      });
    }
  }

  for (const acct of input.emailAccounts) {
    if (!acct.hasGrant) {
      items.push({
        key: `email-${acct.name}`,
        title: `${acct.selfEmail || acct.name} missing grant`,
        detail: 'No mail grant connected',
        tone: 'danger',
        to: '/channels',
      });
    }
  }

  return items;
}

// Small typed JSON reader — throws on non-2xx with the backend error message
// when present (mirrors the per-page errorMessage idiom).
async function readErrorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      // Non-JSON / malformed body — the status code below is still a useful
      // message, but log so a broken error payload isn't lost (matches the
      // sibling errorMessage helpers across the console pages).
      console.error('[dashboard readErrorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await apiFetch(path, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as T;
}

// These endpoints contractually return an array (empty when there's nothing),
// so a missing/non-array field on a 200 is a shape violation — NOT an empty
// result. Surfacing it as an error keeps the attention card honest: a broken
// jobs/channels endpoint must never silently read as a clean "all clear".
function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} returned an unexpected response`);
  }
  return value as T[];
}

// Fetch all four attention sources concurrently, then aggregate. A failure in
// any one rejects the whole card (scoped to this card only, never the page).
export async function fetchAttention(signal?: AbortSignal): Promise<AttentionItem[]> {
  const [failed, suspended, channels, emails] = await Promise.all([
    fetchJson<{ jobs: DashboardJob[] }>('/api/jobs?status=failed', signal),
    fetchJson<{ jobs: DashboardJob[] }>('/api/jobs?status=suspended', signal),
    fetchJson<{ channels: DashboardChannel[] }>('/api/registry/channels', signal),
    fetchJson<{ accounts: DashboardEmailAccount[] }>('/api/registry/email-accounts', signal),
  ]);
  return aggregateAttention({
    failedJobs: requireArray<DashboardJob>(failed.jobs, '/api/jobs?status=failed'),
    suspendedJobs: requireArray<DashboardJob>(suspended.jobs, '/api/jobs?status=suspended'),
    channels: requireArray<DashboardChannel>(channels.channels, '/api/registry/channels'),
    emailAccounts: requireArray<DashboardEmailAccount>(emails.accounts, '/api/registry/email-accounts'),
  });
}

// ── Activity (job-level feed, GET /api/activity) ─────────────────────────────

// Mirrors src/activity/types.ts. One item per job, already in words; the
// backend never puts tool names or message bodies in it (#2251).
export type ActivityLink =
  | { kind: 'job'; jobId: string }
  | { kind: 'conversation'; conversationId: string; from: string; to: string };

export interface ActivityItem {
  id: string;
  ts: string;
  actor: string;
  headline: string;
  details: string[];
  outcome: 'success' | 'partial' | 'failed';
  autonomy: 'autonomous' | 'approved' | null;
  link: ActivityLink | null;
}

export interface ActivityFeedData {
  items: ActivityItem[];
  /** IANA timezone the backend wrote dates in — the principal's. Times use it too. */
  timezone: string;
}

// Lookback window for the home Recent Activity card.
const ACTIVITY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// GET /api/activity?from=<now-24h>&limit=20 → newest first.
export async function fetchActivity(signal?: AbortSignal): Promise<ActivityFeedData> {
  const from = new Date(Date.now() - ACTIVITY_LOOKBACK_MS).toISOString();
  const params = new URLSearchParams({ from, limit: '20' });
  const data = await fetchJson<{ items?: ActivityItem[]; timezone?: unknown }>(
    `/api/activity?${params.toString()}`,
    signal,
  );
  const items = requireArray<ActivityItem>(data.items, '/api/activity');
  const timezone = typeof data.timezone === 'string' && data.timezone.length > 0
    ? data.timezone
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { items, timezone };
}

// Where a click on an item goes: the job's page, or an Ant Farm replay of the
// conversation's window (Ant Farm is its own SPA at /antfarm/, so a plain href).
export function activityHref(link: ActivityLink | null): string | null {
  if (!link) return null;
  if (link.kind === 'job') return `/jobs/${encodeURIComponent(link.jobId)}`;
  const params = new URLSearchParams({ conversationId: link.conversationId, from: link.from, to: link.to });
  return `/antfarm/?${params.toString()}`;
}

// Clock time in the principal's timezone, with the date for items before today
// (the card spans 24 hours). A bad zone name falls back to the browser's.
export function formatActivityTime(ts: string, timezone: string, now: Date = new Date()): string {
  const d = new Date(ts);
  const fmt = (zone: string | undefined): string => {
    const opts = zone ? { timeZone: zone } : {};
    const day = (x: Date) => x.toLocaleDateString('en-CA', opts);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...opts });
    if (day(d) === day(now)) return time;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', ...opts })} ${time}`;
  };
  try {
    return fmt(timezone);
  } catch {
    return fmt(undefined);
  }
}

// "ceo-inbox" → "ceo inbox": the muted agent name beside each item.
export function agentLabel(agentId: string): string {
  return agentId.replace(/[-_]+/g, ' ').trim() || 'agent';
}

// ── Greeting ──────────────────────────────────────────────────────────────────

// Time-of-day greeting for the page header. Pure (hour is injected) so it's
// deterministic in tests.
export function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
