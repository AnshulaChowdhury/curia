// types.ts — agenda, coverage and session-load shapes for meeting calls (#2322).

export type AgendaSource = 'principal' | 'routine' | 'coordinator' | 'ad_hoc';
export type AgendaSensitivity = 'internal' | 'confidential' | 'shareable';
export type AgendaStatus = 'pending' | 'in_call' | 'done';
export type TopicCoverage = 'covered' | 'partial' | 'not_reached';

export interface TopicCoverageEntry {
  topic: string;
  coverage: TopicCoverage;
}

export interface AgendaHistoryEntry {
  sessionId: string;
  /** ISO timestamp of the session the coverage describes. */
  date: string;
  topics: TopicCoverageEntry[];
}

export interface AgendaSnapshot {
  agendaId: string;
  title: string;
  topics: string[];
  role: string | null;
  context: string;
  source: AgendaSource;
  sensitivity: AgendaSensitivity;
  scheduledFor: string | null;
  history: AgendaHistoryEntry[];
}

export interface AgendaDoc extends AgendaSnapshot {
  path: string;
  version: number;
  status: AgendaStatus;
  expiresAt: string;
  inCallSession: string | null;
}

export interface AgendaIndexEntry {
  agendaId: string;
  title: string;
  scheduledFor: string | null;
}

export interface SessionAgendas {
  loaded: AgendaSnapshot[];
  index: AgendaIndexEntry[];
}

export interface SessionAgendaLoad {
  agendaId: string;
  loadedAt: string;
  snapshot: AgendaSnapshot;
}

export interface AgendaCoverage {
  agendaId: string;
  topics: TopicCoverageEntry[];
}

export interface ParkAgendaInput {
  title: string;
  topics: string[];
  role?: string | null;
  context: string;
  source: AgendaSource;
  sensitivity?: AgendaSensitivity;
  expiresAt?: Date;
  scheduledFor?: Date | null;
}

export const AGENDA_SOURCES: readonly AgendaSource[] = ['principal', 'routine', 'coordinator', 'ad_hoc'];
export const AGENDA_SENSITIVITIES: readonly AgendaSensitivity[] = ['internal', 'confidential', 'shareable'];
export const AGENDA_STATUSES: readonly AgendaStatus[] = ['pending', 'in_call', 'done'];
export const TOPIC_COVERAGE: readonly TopicCoverage[] = ['covered', 'partial', 'not_reached'];

/** Most restrictive first. Minutes take the strictest label of the agendas they cover. */
export const SENSITIVITY_RANK: Record<AgendaSensitivity, number> = {
  confidential: 3,
  internal: 2,
  shareable: 1,
};
