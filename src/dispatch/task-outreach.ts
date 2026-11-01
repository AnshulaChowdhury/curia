// src/dispatch/task-outreach.ts
//
// Repo for the task_outreach table: who Curia contacted for a task (email, web forms,
// calls), so a later reply from that counterparty can be linked back to the task (#2312).
// Open rows are those not closed and not past expires_at.

import type { DbPool } from '../db/connection.js';
import type { TaskOriginator } from '../contacts/types.js';
import { isUuid } from '../util/uuid.js';

export type OutreachVia = 'email' | 'web_form' | 'signal' | 'sms' | 'slack' | 'phone' | 'other';

export interface TaskOutreachRow {
  id: string;
  taskId: string | null;
  rootTaskId: string | null;
  /** Set for live-turn outreach that has no task. */
  conversationId: string | null;
  /** The agent.task event id of the directing turn. */
  directingEventId: string | null;
  originator: TaskOriginator;
  via: OutreachVia;
  orgName: string | null;
  /** Lowercased. */
  domains: string[];
  /** Lowercased. */
  addresses: string[];
  contactIds: string[];
  givenContact: string | null;
  summary: string;
  /**
   * True only for an explicit act (a send or record-outreach) on a principal-originated turn.
   * A match on an unconfirmed row is a weak link only (Task 3). Confirmed and unconfirmed
   * writes never share a row, so a confirmed act cannot vouch for addresses a backstop
   * write guessed, and a backstop write cannot dilute a confirmed row.
   */
  confirmed: boolean;
  createdAt: Date;
  closedAt: Date | null;
  expiresAt: Date;
}

export type TaskOutreachInput = Omit<TaskOutreachRow, 'id' | 'createdAt' | 'closedAt' | 'expiresAt'>;

// Shared by every finder: only rows still being waited on.
const OPEN = 'closed_at IS NULL AND expires_at > now()';

function normalizeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter((v) => v !== ''))];
}

function normalizeUuids(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter((v) => isUuid(v)))];
}

function mapRow(row: Record<string, unknown>): TaskOutreachRow {
  return {
    id: row.id as string,
    taskId: (row.task_id as string | null) ?? null,
    rootTaskId: (row.root_task_id as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    directingEventId: (row.directing_event_id as string | null) ?? null,
    originator: row.originator as TaskOriginator,
    via: row.via as OutreachVia,
    orgName: (row.org_name as string | null) ?? null,
    domains: (row.domains as string[] | null) ?? [],
    addresses: (row.addresses as string[] | null) ?? [],
    contactIds: (row.contact_ids as string[] | null) ?? [],
    givenContact: (row.given_contact as string | null) ?? null,
    summary: row.summary as string,
    confirmed: row.confirmed === true,
    createdAt: row.created_at as Date,
    closedAt: (row.closed_at as Date | null) ?? null,
    expiresAt: row.expires_at as Date,
  };
}

export class TaskOutreachRepo {
  constructor(private pool: DbPool) {}

  /**
   * Record outreach. Upserts: an open row for the same scope (task_id, or conversation_id
   * when there is no task), the same `via`, the same `confirmed`, and an overlapping domain
   * or address absorbs the new values instead of getting a sibling row. A write never merges
   * across `confirmed`: an unconfirmed write overlapping a confirmed row gets a row of its
   * own (whose matches stay weak), and a confirmed write never upgrades an unconfirmed row.
   */
  async record(input: TaskOutreachInput): Promise<TaskOutreachRow> {
    const domains = normalizeStrings(input.domains);
    const addresses = normalizeStrings(input.addresses);
    const contactIds = normalizeUuids(input.contactIds);

    const merged = await this.pool.query(
      `UPDATE task_outreach t
          SET domains = ARRAY(SELECT DISTINCT d FROM unnest(t.domains || $4::text[]) AS d ORDER BY d),
              addresses = ARRAY(SELECT DISTINCT a FROM unnest(t.addresses || $5::text[]) AS a ORDER BY a),
              contact_ids = ARRAY(SELECT DISTINCT c FROM unnest(t.contact_ids || $6::uuid[]) AS c ORDER BY c),
              org_name = COALESCE(t.org_name, $7::text),
              given_contact = COALESCE($8::text, t.given_contact)
        WHERE t.id = (
          SELECT id FROM task_outreach
           WHERE ${OPEN} AND via = $3 AND confirmed = $9::boolean
             AND (($1::uuid IS NOT NULL AND task_id = $1::uuid)
               OR ($1::uuid IS NULL AND task_id IS NULL AND $2::text IS NOT NULL AND conversation_id = $2::text))
             AND (domains && $4::text[] OR addresses && $5::text[])
           ORDER BY created_at DESC
           LIMIT 1
        )
        RETURNING t.*`,
      [
        input.taskId, input.conversationId, input.via, domains, addresses, contactIds,
        input.orgName, input.givenContact, input.confirmed,
      ],
    );
    const mergedRow = merged.rows[0];
    if (mergedRow) return mapRow(mergedRow);

    const inserted = await this.pool.query(
      `INSERT INTO task_outreach
         (task_id, root_task_id, conversation_id, directing_event_id, originator, via,
          org_name, domains, addresses, contact_ids, given_contact, summary, confirmed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        input.taskId, input.rootTaskId, input.conversationId, input.directingEventId,
        JSON.stringify(input.originator), input.via, input.orgName, domains, addresses,
        contactIds, input.givenContact, input.summary, input.confirmed,
      ],
    );
    return mapRow(inserted.rows[0]!);
  }

  /** One row by id, open or not; null when missing or the id is not a UUID (#2312: a link's originator). */
  async getById(id: string): Promise<TaskOutreachRow | null> {
    if (!isUuid(id)) return null;
    const result = await this.pool.query(`SELECT * FROM task_outreach WHERE id = $1`, [id.toLowerCase()]);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  /** Open rows, newest first. */
  async findOpen(limit: number): Promise<TaskOutreachRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM task_outreach WHERE ${OPEN} ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  }

  async findOpenByAddress(address: string): Promise<TaskOutreachRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM task_outreach WHERE ${OPEN} AND addresses @> ARRAY[$1]::text[] ORDER BY created_at DESC`,
      [address.trim().toLowerCase()],
    );
    return result.rows.map(mapRow);
  }

  async findOpenByContact(contactId: string): Promise<TaskOutreachRow[]> {
    if (!isUuid(contactId)) return [];
    const result = await this.pool.query(
      `SELECT * FROM task_outreach WHERE ${OPEN} AND contact_ids @> ARRAY[$1]::uuid[] ORDER BY created_at DESC`,
      [contactId.toLowerCase()],
    );
    return result.rows.map(mapRow);
  }

  async findOpenByDomain(domain: string): Promise<TaskOutreachRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM task_outreach WHERE ${OPEN} AND domains @> ARRAY[$1]::text[] ORDER BY created_at DESC`,
      [domain.trim().toLowerCase()],
    );
    return result.rows.map(mapRow);
  }

  /** Add a sender seen replying to a row, so the next message from them matches directly. */
  async learnCounterparty(id: string, sender: { address?: string; contactId?: string }): Promise<void> {
    const addresses = normalizeStrings(sender.address ? [sender.address] : []);
    const contactIds = normalizeUuids(sender.contactId ? [sender.contactId] : []);
    if (addresses.length === 0 && contactIds.length === 0) return;
    await this.pool.query(
      `UPDATE task_outreach
          SET addresses = ARRAY(SELECT DISTINCT a FROM unnest(addresses || $2::text[]) AS a ORDER BY a),
              contact_ids = ARRAY(SELECT DISTINCT c FROM unnest(contact_ids || $3::uuid[]) AS c ORDER BY c)
        WHERE id = $1 AND ${OPEN}`,
      [id, addresses, contactIds],
    );
  }

  /**
   * Reopen a reopened task's closed rows that have not expired, so a reply can find the task
   * again (#2312). Returns how many were reopened.
   */
  async reopenForTask(taskId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE task_outreach SET closed_at = NULL WHERE task_id = $1 AND closed_at IS NOT NULL AND expires_at > now()`,
      [taskId],
    );
    return result.rowCount ?? 0;
  }

  /** Close every open row for a task; returns how many were closed. */
  async closeForTask(taskId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE task_outreach SET closed_at = now() WHERE task_id = $1 AND closed_at IS NULL`,
      [taskId],
    );
    return result.rowCount ?? 0;
  }
}
