// replay-params.ts — read a replay window from the page URL.
//
// The console's activity feed links a conversation item here as
// /antfarm/?conversationId=…&from=…&to=… (#2251), so the page preloads that
// job's window instead of the default last 24 hours. Any missing or invalid
// value falls back to the default.

export interface ReplayParams {
  from: Date;
  to: Date;
  conversationId: string;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function readReplayParams(search: string, now: Date = new Date()): ReplayParams {
  const params = new URLSearchParams(search);
  const from = parseDate(params.get('from'));
  const to = parseDate(params.get('to'));
  const conversationId = params.get('conversationId')?.trim() ?? '';
  if (from && to && from < to) return { from, to, conversationId };
  return { from: new Date(now.getTime() - DEFAULT_WINDOW_MS), to: now, conversationId };
}
