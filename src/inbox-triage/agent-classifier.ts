// agent-classifier.ts — runs the email-classifier agent for one message and reads its verdict (FR-ETC).
//
// Uses the same bus path the scheduler uses: a schedule.fired event as the trace parent, then an agent.task.
// The agent's reply is parsed and validated by parseVerdict(); nothing the model says reaches a label raw.

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../bus/bus.js';
import { createAgentTask, createScheduleFired } from '../bus/events.js';
import type { AgentResponseEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import { NO_VERDICT, parseVerdict, type TriageCandidate, type TriageVerdict } from './types.js';
import type { Classifier } from './watcher.js';

export const CLASSIFIER_AGENT_ID = 'email-classifier';

interface Pending {
  resolve: (content: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentClassifierConfig {
  bus: EventBus;
  logger: Logger;
  /** Below this, urgent and drafted are downgraded to seen (FR-ETC-5). */
  minConfidence: number;
  /** Hard limit on one classification. A timeout means 'none': the sweep covers the message. */
  timeoutMs: number;
}

/** The task text. Email fields are fenced and capped so they read as data (FR-ETC-6). */
export function buildClassifierTask(c: TriageCandidate): string {
  const clip = (s: string, n: number) => s.replace(/[\r\n]+/g, ' ').slice(0, n);
  return [
    'Classify this new email. Reply with the JSON line only.',
    '<email>',
    `From: ${clip(c.from, 200)}`,
    `Subject: ${clip(c.subject, 300)}`,
    `Preview: ${clip(c.snippet, 400)}`,
    '</email>',
  ].join('\n');
}

export class AgentClassifier implements Classifier {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly config: AgentClassifierConfig) {
    // One system-layer subscription resolves whichever task each response belongs to.
    config.bus.subscribe('agent.response', 'system', (event) => {
      const response = event as AgentResponseEvent;
      const parentId = response.parentEventId;
      if (!parentId) return;
      const waiting = this.pending.get(parentId);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(parentId);
      waiting.resolve(response.payload.isError ? null : response.payload.content);
    });
  }

  async classify(candidate: TriageCandidate): Promise<TriageVerdict> {
    const { bus, logger, minConfidence, timeoutMs } = this.config;
    const runId = randomUUID();
    const fired = createScheduleFired({ jobId: `inbox-triage:${runId}`, agentId: CLASSIFIER_AGENT_ID, agentTaskId: null });
    const task = createAgentTask({
      agentId: CLASSIFIER_AGENT_ID,
      conversationId: `inbox-triage:${runId}`,
      channelId: 'scheduler',
      senderId: 'inbox-triage',
      content: buildClassifierTask(candidate),
      parentEventId: fired.id,
    });

    const answer = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(task.id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(task.id, { resolve, timer });
    });

    await bus.publish('system', fired);
    await bus.publish('system', task);

    const content = await answer;
    if (content === null) {
      logger.warn({ accountId: candidate.accountId, messageId: candidate.messageId }, 'inbox-triage: classifier gave no usable answer');
      return NO_VERDICT;
    }
    return parseVerdict(content, minConfidence);
  }
}
