// What Settings → History reads from the server, and how it is worded.

import { apiFetch } from '../../api.js';

export interface Conversation {
  id: string | null;
  title: string;
  startedAt: string;
  lastAt: string;
  events: number;
  errors: number;
  agents: string[];
  channels: string[];
  costUsd: number;
}
export interface ConversationList { conversations: Conversation[]; hasMore: boolean; agents: string[]; channels: string[] }
export interface Step { id: string; seq: string; at: string; type: string; agent: string | null; depth: number; label: string; preview: string; failed: boolean }
export interface StepPage { steps: Step[]; hasEarlier: boolean }
export interface Detail {
  payload: unknown;
  result: unknown;
  archive: { prompt: unknown; response: unknown; toolDefinitions: unknown } | null;
  notes: string[];
}

/** The chosen filters. Dates are yyyy-mm-dd in the browser's time zone, both ends included. */
export interface Filters { from: string; to: string; agent: string; channel: string; errorsOnly: boolean }

const day = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function defaultFilters(now = new Date()): Filters {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  return { from: day(from), to: day(now), agent: '', channel: '', errorsOnly: false };
}

/** The window as the server takes it: from the start of the first day to the start of the day after the last. */
function windowParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    params.set('to', end.toISOString());
  }
  return params;
}

export function listPath(filters: Filters, offset: number): string {
  const params = windowParams(filters);
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.errorsOnly) params.set('errors', '1');
  if (offset > 0) params.set('offset', String(offset));
  return `/api/history?${params}`;
}

export function stepsPath(filters: Filters, conversationId: string | null, before?: string): string {
  const params = windowParams(filters);
  if (conversationId !== null) params.set('conversation', conversationId);
  if (before) params.set('before', before);
  return `/api/history/steps?${params}`;
}

export async function read<T>(path: string, fetcher: (path: string) => Promise<Response> = apiFetch): Promise<T> {
  const res = await fetcher(path);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return await res.json() as T;
}

/** What to call a conversation that has no message to quote. */
export function conversationTitle(conversation: Conversation): string {
  if (conversation.title) return conversation.title;
  if (conversation.id === null) return 'Activity outside any conversation';
  if (conversation.id === 'system') return 'Background AI calls (voice calls included)';
  return conversation.id;
}

export interface Block { heading: string; body: string }

const pretty = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '');
const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;

/** A record laid out as input and output, followed by everything that was stored. */
export function detailBlocks(detail: Detail): Block[] {
  const blocks: Block[] = [];
  const add = (heading: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') blocks.push({ heading, body: pretty(value) });
  };
  if (detail.archive) {
    add('Prompt', detail.archive.prompt);
    add('Reply', detail.archive.response);
    add('Tools offered', detail.archive.toolDefinitions);
  }
  add('Input', field(detail.payload, 'input'));
  add('Output', field(detail.payload, 'result') ?? field(detail.result, 'result'));
  add('Message', field(detail.payload, 'content'));
  add('Full record', detail.payload);
  return blocks;
}
