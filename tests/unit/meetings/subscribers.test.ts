import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createVoiceSessionEnded } from '../../../src/bus/events.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { Logger } from '../../../src/logger.js';
import type { MinutesPipeline } from '../../../src/meetings/minutes-pipeline.js';
import { MeetingSessionEndedSubscriber } from '../../../src/meetings/subscribers.js';

describe('MeetingSessionEndedSubscriber', () => {
  it('voice.session.ended handler returns before the pipeline settles', async () => {
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pipeline = {
      run: () => {
        started = true;
        return gate.then(() => 'completed' as const);
      },
    } as unknown as MinutesPipeline;
    const bus = new EventBus(createSilentLogger());
    new MeetingSessionEndedSubscriber({ bus, pipeline, logger: createSilentLogger() }).start();

    await bus.publish('system', createVoiceSessionEnded({
      sessionId: 'sess',
      conversationId: 'voice:sess',
      reason: 'remote_hangup',
    }));

    expect(started).toBe(true);
    release();
    await gate;
  });

  it('a rejected pipeline run is logged, not thrown', async () => {
    const error = vi.fn();
    const logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger;
    const pipeline = {
      run: async () => {
        throw new Error('boom');
      },
    } as unknown as MinutesPipeline;
    const bus = new EventBus(createSilentLogger());
    new MeetingSessionEndedSubscriber({ bus, pipeline, logger }).start();

    await expect(bus.publish('system', createVoiceSessionEnded({
      sessionId: 'sess',
      conversationId: 'voice:sess',
      reason: 'remote_hangup',
    }))).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalled();
  });
});
