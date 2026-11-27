export type MessageKind = 'user' | 'agent' | 'status' | 'error';

export interface Message {
  id: string;        // crypto.randomUUID() — stable React key
  kind: MessageKind;
  text: string;
  html?: string;     // Pre-rendered HTML for agent messages (server-side markdown conversion)
  timestamp?: Date;  // Display time; absent for status and error messages
}

/**
 * A parsed SSE event from GET /api/chat/stream, normalized for the chat UI.
 * - step-start / step-end: a tool began or finished, in this chat or in a specialist it asked.
 * - reply:    the agent's final reply for this turn (terminal).
 * - rejected: the turn was rejected before reaching the agent (terminal error).
 * parseSseEvent returns null for everything else (tool.result, malformed, etc.).
 */
export type SseEvent =
  | { kind: 'step-start'; agent: string; tool: string; delegateTo?: string }
  | { kind: 'step-end'; agent: string; tool: string; ok: boolean }
  | { kind: 'reply'; text: string; html: string | null }
  | { kind: 'rejected'; text: string };

/** A chat history row as returned by GET /api/chat/history. */
export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html: string | null;
  timestamp: string;
}
