// followup-exit.ts — when a scenario follow-up may join at the exit hook.
//
// The runtime publishes llm.call and awaits every subscriber before it
// returns the response to the streaming loop. A text response's next step is
// the exit hook (beforeFinish → closeIfIdle). Publishing the follow-up inside
// that subscriber fills the queue before closeIfIdle, so the correction drains
// at `exit` instead of being missed. A tool_use response is not this signal:
// that follow-up waits until the first tool call is in flight.

import type { BusEvent } from '../../src/bus/events.js';

/** True when this llm.call is a text finish, the step immediately before the exit hook. */
export function isTextFinishCall(event: BusEvent): boolean {
  if (event.type !== 'llm.call') return false;
  const response = event.archive?.response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return false;
  return (response as { type?: unknown }).type === 'text';
}

/**
 * A follow-up drained before the model had chosen. `exit` and `round:N` are
 * the points the harness aims for, so they are not errors.
 */
export function turnStartDrainError(drainPoint: string): string | undefined {
  if (drainPoint !== 'turn_start') return undefined;
  return 'follow-up drained at turn_start; the correction joined before the model had chosen';
}
