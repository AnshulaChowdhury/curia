// agent-classifier.ts — runs the email-classifier agent for one message and reads its verdict (FR-ETC).
//
// Uses the same bus path the scheduler uses: a schedule.fired event as the trace parent, then an agent.task.
// The agent's reply is parsed and validated by parseVerdict(); nothing the model says reaches a label raw.

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../bus/bus.js';
import { createAgentTask, createScheduleFired } from '../bus/events.js';
import type { AgentResponseEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import { NO_VERDICT, parseVerdict, TRIAGE_LABELS, type TriageCandidate, type TriageGroup, type TriageVerdict } from './types.js';
import type { ContactLookup } from './contact-lookup.js';
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
  /** Tells the classifier when the sender is in the principal's contacts. Optional. */
  contacts?: ContactLookup;
  /** What the owner said earlier about this sender or its domain. Optional; a failure just means no hint. */
  preferences?: { lookup(accountId: string, fromAddress: string): Promise<TriageGroup | null> };
}

/** The task text. Email fields are fenced and capped so they read as data (FR-ETC-6). */
export function buildClassifierTask(c: TriageCandidate, knownContact = false, earlierChoice: TriageGroup | null = null): string {
  const clip = (s: string, n: number) => s.replace(/[\r\n]+/g, ' ').slice(0, n);
  return [
    'Classify this new email. Reply with the JSON line only.',
    '<email>',
    `From: ${clip(c.from, 200)}`,
    ...(knownContact ? ['Known contact: yes'] : []),
    ...(earlierChoice ? [`Earlier choice: ${TRIAGE_LABELS[earlierChoice]}`] : []),
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

  private async earlierChoice(candidate: TriageCandidate): Promise<TriageGroup | null> {
    const { preferences, logger } = this.config;
    if (!preferences || !candidate.fromAddress) return null;
    try {
      return await preferences.lookup(candidate.accountId, candidate.fromAddress);
    } catch (err) {
      logger.warn({ err }, 'inbox-triage: preference lookup failed, classifying without it');
      return null;
    }
  }

  async classify(candidate: TriageCandidate): Promise<TriageVerdict> {
    const { bus, logger, minConfidence, timeoutMs } = this.config;
    const knownContact = candidate.fromAddress && this.config.contacts ? await this.config.contacts.isKnown(candidate.fromAddress) : false;
    const earlierChoice = await this.earlierChoice(candidate);
    const runId = randomUUID();
    const fired = createScheduleFired({ jobId: `inbox-triage:${runId}`, agentId: CLASSIFIER_AGENT_ID, agentTaskId: null });
    const task = createAgentTask({
      agentId: CLASSIFIER_AGENT_ID,
      conversationId: `inbox-triage:${runId}`,
      channelId: 'scheduler',
      senderId: 'inbox-triage',
      content: buildClassifierTask(candidate, knownContact, earlierChoice),
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
