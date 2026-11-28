// Tools run outside an agent turn are recorded with what went in and what came out (ADR-072).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { BusEvent } from '../../../src/bus/events.js';

const run = async (options: Parameters<ExecutionLayer['invoke']>[3]) => {
  const events: BusEvent[] = [];
  const logger = createSilentLogger();
  const bus = new EventBus(logger, (event) => { events.push(event); });
  const layer = new ExecutionLayer(new ToolRegistry(), logger, { bus });
  const result = await layer.invoke('no-such-tool', { a: 1 }, undefined, options);
  return { result, recorded: events.filter(e => e.type === 'tool.recorded') };
};

describe('recording a tool run outside a turn', () => {
  it('publishes the input and the outcome', async () => {
    const { result, recorded } = await run({ record: { by: 'system:approval', conversationId: 'c1' } });
    expect(recorded.map(e => e.payload)).toEqual([
      { agentId: 'system:approval', conversationId: 'c1', toolName: 'no-such-tool', input: { a: 1 }, result, durationMs: expect.any(Number) },
    ]);
  });

  it('records nothing for a turn, which publishes its own events', async () => {
    expect((await run({ agentId: 'coordinator' })).recorded).toEqual([]);
  });

  // The agent runtime and voice publish tool.invoke and tool.result around their calls. Every other caller must ask
  // for a record, or its work is missing from History.
  it('is asked for by every other caller in src/', () => {
    const own = new Set(['agents/runtime.ts', 'index.ts']);
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') && !entry.name.startsWith('._') ? [join(dir, entry.name)] : []);
    const root = join(import.meta.dirname, '../../../src');
    const missing = files(root).filter((file) => {
      const source = readFileSync(file, 'utf8');
      if (own.has(file.slice(root.length + 1))) return false;
      return source.includes('executionLayer.invoke(') && !source.includes('record: { by:');
    });
    expect(missing).toEqual([]);
  });
});
