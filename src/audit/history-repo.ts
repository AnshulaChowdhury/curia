// history-repo.ts — what every agent did, read back from the audit log for the History screen (ADR-072).
//
// Read only. A conversation includes the specialist conversations it delegated to. Everything returned passes through
// the secret redactor, so rows written before secrets were removed on the way in are masked here.

import type { Pool } from 'pg';
import { redactSecrets, redactSecretsDeep } from '../security/redact-secrets.js';
import { UUID_PATTERN } from '../util/uuid.js';

export interface HistoryWindow { from: Date; to: Date }

export interface HistoryFilters extends HistoryWindow {
  agent?: string;
  channel?: string;
  errorsOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface HistoryConversation {
  /** Null for events that belong to no conversation. */
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

export interface HistoryStep {
  id: string;
  /** Position in the audit log; also the paging cursor. */
  seq: string;
  at: string;
  type: string;
  agent: string | null;
  /** 0 for the conversation itself, 1 and up for specialists it delegated to. */
  depth: number;
  label: string;
  preview: string;
  failed: boolean;
}

export interface HistoryDetail {
  id: string;
  at: string;
  type: string;
  conversationId: string | null;
  payload: unknown;
  /** The tool.result of a tool.invoke. */
  result: unknown;
  /** The full prompt and reply of an AI call. */
  archive: { prompt: unknown; response: unknown; toolDefinitions: unknown } | null;
  /** What is missing or shortened in this record, so a partial one does not read as complete. */
  notes: string[];
}

const PREVIEW_LENGTH = 200;
const MAX_DELEGATION_DEPTH = 10;
export const HISTORY_PAGE = 50;
export const HISTORY_STEPS_PAGE = 200;

const INVOKES = ['tool.invoke', 'skill.invoke'];
const RESULTS = ['tool.result', 'skill.result'];
const TRUNCATED = '[truncated — output exceeded limit]';

/** A failed tool, send or AI call, whichever way the row says so. */
const FAILED_SQL = `(outcome IN ('failure', 'error') OR event_type IN ('llm.error', 'agent.error') OR payload->>'isError' = 'true')`;

type Payload = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const oneLine = (value: string): string => {
  const flat = redactSecrets(value).replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
};
const json = (value: unknown): string => (value === undefined ? '' : JSON.stringify(redactSecretsDeep(value)));

/** A step's heading and one line about it. */
export function describeEvent(type: string, payload: Payload): { label: string; preview: string } {
  const agent = text(payload.agentId) || 'an agent';
  const tool = text(payload.toolName) || text(payload.skillName) || 'tool';
  const channel = text(payload.channelId);
  const on = channel ? ` (${channel})` : '';
  switch (type) {
    case 'inbound.message': return { label: `Message received${on}`, preview: oneLine(text(payload.content)) };
    case 'agent.task': return { label: `Task given to ${agent}`, preview: oneLine(text(payload.content)) };
    case 'agent.response': return { label: `${agent} answered`, preview: oneLine(text(payload.content)) };
    case 'outbound.message': return { label: `Reply sent${on}`, preview: oneLine(text(payload.content)) };
    case 'agent.error': return { label: 'Error', preview: oneLine(text(payload.message)) };
    case 'tool.invoke':
    case 'skill.invoke': return { label: `Tool: ${tool}`, preview: oneLine(json(payload.input)) };
    case 'tool.result':
    case 'skill.result': return { label: `Result: ${tool}`, preview: oneLine(json(payload.result)) };
    case 'tool.recorded': return { label: `Tool: ${tool}`, preview: oneLine(json(payload.input)) };
    case 'llm.call': {
      const cost = typeof payload.estimatedCostUsd === 'number' ? ` · $${payload.estimatedCostUsd.toFixed(4)}` : '';
      return {
        label: 'AI call',
        preview: `${text(payload.actualModel)} · ${Number(payload.inputTokens ?? 0)} tokens in, ${Number(payload.outputTokens ?? 0)} out${cost}`,
      };
    }
    case 'llm.error': return { label: 'AI call failed', preview: oneLine(`${text(payload.errorType)} ${text(payload.requestedModel)}`) };
    default: return { label: type, preview: oneLine(json(payload)) };
  }
}

export class HistoryRepo {
  constructor(private readonly pool: Pool) {}

  /** Conversations and background work with activity in the window, most recent first. */
  async conversations(filters: HistoryFilters): Promise<{ conversations: HistoryConversation[]; hasMore: boolean }> {
    const limit = filters.limit ?? HISTORY_PAGE;
    const result = await this.pool.query<{
      root: string | null; started_at: Date; last_at: Date; events: number; errors: number;
      agents: string[] | null; channels: string[] | null; title: string | null; cost: string | null;
    }>(
      `WITH RECURSIVE window_rows AS (
         SELECT conversation_id, timestamp, event_type, payload, ${FAILED_SQL} AS failed,
                payload->>'agentId' AS agent, NULLIF(payload->>'channelId', 'internal') AS channel
           FROM audit_log
          WHERE timestamp >= $1 AND timestamp < $2
       ),
       links AS (
         SELECT DISTINCT ON (conversation_id) conversation_id AS child,
                payload->'metadata'->'delegationOrigin'->>'conversationId' AS parent
           FROM window_rows
          WHERE event_type = 'agent.task'
            AND payload->'metadata'->'delegationOrigin'->>'conversationId' <> conversation_id
          ORDER BY conversation_id, timestamp
       ),
       up(child, ancestor, depth) AS (
         SELECT child, parent, 1 FROM links
         UNION ALL
         SELECT up.child, links.parent, up.depth + 1 FROM up JOIN links ON links.child = up.ancestor WHERE up.depth < $3
       ),
       roots AS (SELECT DISTINCT ON (child) child, ancestor FROM up ORDER BY child, depth DESC)
       SELECT COALESCE(roots.ancestor, w.conversation_id) AS root,
              min(w.timestamp) AS started_at, max(w.timestamp) AS last_at,
              count(*)::int AS events, (count(*) FILTER (WHERE w.failed))::int AS errors,
              array_agg(DISTINCT w.agent) FILTER (WHERE w.agent IS NOT NULL) AS agents,
              array_agg(DISTINCT w.channel) FILTER (WHERE w.channel IS NOT NULL) AS channels,
              (array_agg(left(w.payload->>'content', 2000) ORDER BY (w.event_type <> 'inbound.message'), w.timestamp)
                 FILTER (WHERE w.event_type IN ('inbound.message', 'agent.task')))[1] AS title,
              sum((w.payload->>'estimatedCostUsd')::numeric) FILTER (WHERE w.event_type = 'llm.call') AS cost
         FROM window_rows w LEFT JOIN roots ON roots.child = w.conversation_id
        GROUP BY 1
       HAVING ($4::text IS NULL OR bool_or(w.agent = $4))
          AND ($5::text IS NULL OR bool_or(w.channel = $5))
          AND (NOT $6::boolean OR bool_or(w.failed))
        ORDER BY max(w.timestamp) DESC, 1
        LIMIT $7 OFFSET $8`,
      [filters.from, filters.to, MAX_DELEGATION_DEPTH, filters.agent ?? null, filters.channel ?? null,
        filters.errorsOnly === true, limit + 1, filters.offset ?? 0],
    );
    return {
      hasMore: result.rows.length > limit,
      conversations: result.rows.slice(0, limit).map(row => ({
        id: row.root,
        title: row.title ? oneLine(row.title) : '',
        startedAt: row.started_at.toISOString(),
        lastAt: row.last_at.toISOString(),
        events: row.events,
        errors: row.errors,
        agents: row.agents ?? [],
        channels: row.channels ?? [],
        costUsd: Number(row.cost ?? 0),
      })),
    };
  }

  /** The agents and channels that appear in the window, for the filters. */
  async facets(window: HistoryWindow): Promise<{ agents: string[]; channels: string[] }> {
    const result = await this.pool.query<{ agents: string[] | null; channels: string[] | null }>(
      `SELECT array_agg(DISTINCT payload->>'agentId') FILTER (WHERE payload->>'agentId' IS NOT NULL) AS agents,
              array_agg(DISTINCT payload->>'channelId')
                FILTER (WHERE payload->>'channelId' IS NOT NULL AND payload->>'channelId' <> 'internal') AS channels
         FROM audit_log
        WHERE timestamp >= $1 AND timestamp < $2`,
      [window.from, window.to],
    );
    return { agents: result.rows[0]?.agents ?? [], channels: result.rows[0]?.channels ?? [] };
  }

  /** The newest steps of one conversation before the cursor, returned oldest first. */
  async steps(query: HistoryWindow & { conversationId: string | null; before?: string; limit?: number }): Promise<{ steps: HistoryStep[]; hasEarlier: boolean }> {
    const limit = query.limit ?? HISTORY_STEPS_PAGE;
    const depths = new Map<string, number>();
    if (query.conversationId !== null) {
      const tree = await this.pool.query<{ id: string; depth: number }>(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT $1::text, 0
           UNION
           SELECT a.conversation_id, tree.depth + 1
             FROM tree JOIN audit_log a
               ON a.event_type = 'agent.task' AND a.payload->'metadata'->'delegationOrigin'->>'conversationId' = tree.id
            WHERE tree.depth < $2 AND a.conversation_id IS NOT NULL
         )
         SELECT id, min(depth)::int AS depth FROM tree GROUP BY id`,
        [query.conversationId, MAX_DELEGATION_DEPTH],
      );
      for (const row of tree.rows) depths.set(row.id, row.depth);
    }

    const params: unknown[] = [query.from, query.to, query.before ?? null, limit + 1, RESULTS, INVOKES, `^${UUID_PATTERN}$`];
    let scope = 'a.conversation_id IS NULL';
    if (query.conversationId !== null) {
      params.push([...depths.keys()]);
      scope = 'a.conversation_id = ANY($8::text[])';
    }
    // A result is shown with the call it answers, so it is not a step of its own.
    const result = await this.pool.query<{
      id: string; seq: string; timestamp: Date; event_type: string; conversation_id: string | null; payload: Payload; failed: boolean | null;
    }>(
      `SELECT a.id, a.seq::text AS seq, a.timestamp, a.event_type, a.conversation_id, a.payload, ${FAILED_SQL} AS failed
         FROM audit_log a
        WHERE ${scope}
          AND a.timestamp >= $1 AND a.timestamp < $2
          AND ($3::bigint IS NULL OR a.seq < $3::bigint)
          AND NOT (a.event_type = ANY($5::text[]) AND EXISTS (
                SELECT 1 FROM audit_log call
                 -- parent_event_id is text and not always an id; cast only when it is one, so the key index serves.
                 WHERE call.id = (CASE WHEN a.parent_event_id ~ $7 THEN a.parent_event_id::uuid END)
                   AND call.event_type = ANY($6::text[])))
        ORDER BY a.seq DESC
        LIMIT $4`,
      params,
    );
    const rows = result.rows.slice(0, limit).reverse();

    const calls = rows.filter(r => INVOKES.includes(r.event_type)).map(r => r.id);
    const outcomes = new Map<string, boolean>();
    if (calls.length > 0) {
      const results = await this.pool.query<{ parent_event_id: string; failed: boolean | null }>(
        `SELECT parent_event_id, ${FAILED_SQL} AS failed FROM audit_log
          WHERE parent_event_id = ANY($1::text[]) AND event_type = ANY($2::text[])`,
        [calls, RESULTS],
      );
      for (const row of results.rows) outcomes.set(row.parent_event_id, row.failed === true);
    }

    return {
      hasEarlier: result.rows.length > limit,
      steps: rows.map(row => ({
        id: row.id,
        seq: row.seq,
        at: row.timestamp.toISOString(),
        type: row.event_type,
        agent: text(row.payload.agentId) || null,
        depth: depths.get(row.conversation_id ?? '') ?? 0,
        ...describeEvent(row.event_type, row.payload),
        failed: row.failed === true || outcomes.get(row.id) === true,
      })),
    };
  }

  /** Everything kept about one step. */
  async detail(id: string): Promise<HistoryDetail | null> {
    const found = await this.pool.query<{ id: string; timestamp: Date; event_type: string; conversation_id: string | null; payload: Payload }>(
      'SELECT id, timestamp, event_type, conversation_id, payload FROM audit_log WHERE id = $1',
      [id],
    );
    const row = found.rows[0];
    if (!row) return null;
    const notes: string[] = [];
    let result: unknown = null;
    let archive: HistoryDetail['archive'] = null;

    if (INVOKES.includes(row.event_type)) {
      const answer = await this.pool.query<{ payload: Payload }>(
        'SELECT payload FROM audit_log WHERE parent_event_id = $1 AND event_type = ANY($2::text[]) ORDER BY seq LIMIT 1',
        [id, RESULTS],
      );
      result = answer.rows[0]?.payload ?? null;
      if (result === null) notes.push('No result was recorded for this call.');
    }
    if (row.event_type === 'llm.call') {
      const kept = await this.pool.query<{ prompt: unknown; response: unknown; tool_definitions: unknown }>(
        'SELECT prompt, response, tool_definitions FROM llm_call_archive WHERE audit_event_id = $1',
        [id],
      );
      const stored = kept.rows[0];
      if (stored) {
        archive = { prompt: stored.prompt, response: stored.response, toolDefinitions: stored.tool_definitions };
        notes.push('Passwords, keys and personal details such as email addresses and phone numbers are masked in this copy.');
      } else {
        notes.push('The full prompt and reply were not kept for this call.');
      }
    }
    if (JSON.stringify([row.payload, result]).includes(TRUNCATED)) {
      notes.push('A result was cut off at the size limit. The agent received the same shortened text.');
    }

    return redactSecretsDeep({
      id: row.id, at: row.timestamp.toISOString(), type: row.event_type, conversationId: row.conversation_id,
      payload: row.payload, result, archive, notes,
    });
  }
}
