import { describe, expect, it } from 'vitest';
import type { BusEvent } from '../../../src/bus/events.js';
import { isTextFinishCall } from '../../scenarios/followup-exit.js';

function llmCall(response: unknown): BusEvent {
  return {
    type: 'llm.call',
    archive: { prompt: {}, response, toolDefinitions: [] },
  } as BusEvent;
}

describe('isTextFinishCall', () => {
  it('is true only for a text llm.call, the step before the exit hook', () => {
    expect(isTextFinishCall(llmCall({ type: 'text', content: 'ask for the code' }))).toBe(true);
    expect(isTextFinishCall(llmCall({ type: 'tool_use', toolCalls: [] }))).toBe(false);
    expect(isTextFinishCall(llmCall(null))).toBe(false);
    expect(isTextFinishCall(llmCall('text'))).toBe(false);
    expect(isTextFinishCall({ type: 'agent.response' } as BusEvent)).toBe(false);
  });
});