// scripts/spikes/thinking-off-small-caps/measure.ts — #2224 measurement.
//
// Runs the real small-cap NO_REASONING call sites (the infra-llm classifier at
// 10 tokens, the outbound leak judge at 200, the escalation judge's disclosure
// and action verdicts at 200 and 300, and the drift detector at 200) against
// OpenRouter models whose registry entry does not list `none`, and records
// whether each call returned a complete answer or spent its cap on thinking.
//
// Each call goes through the call-site class itself, so the request carries the
// same options production sends (NO_REASONING, which OpenRouterProvider leaves
// out for these models, so the model's default reasoning applies).
//
// Usage (bills OpenRouter; about $0.05 for the default run):
//   OPENROUTER_API_KEY=… pnpm exec tsx scripts/spikes/thinking-off-small-caps/measure.ts [runs]
//
// Writes results.json beside this file and prints a summary table.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenRouterProvider } from '../../../src/agents/llm/openrouter.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../../src/agents/llm/model-router.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';
import { InfraLlmService } from '../../../src/skills/infra-llm.js';
import { OutboundLlmJudge } from '../../../src/dispatch/outbound-judge.js';
import { EscalationJudge } from '../../../src/autonomy/escalation-judge.js';
import { DriftDetector } from '../../../src/scheduler/drift-detector.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { createSilentLogger } from '../../../src/logger.js';

const MODELS = ['deepseek/deepseek-v4.1-flash', 'google/gemini-3.1-flash-lite'] as const;
const RUNS = Number(process.argv[2] ?? 3);

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  process.stderr.write('OPENROUTER_API_KEY is required\n');
  process.exit(1);
}

const logger = createSilentLogger();
const registry = new ModelRegistry(logger);
const bus = { publish: async () => undefined } as unknown as EventBus;

interface CallRecord {
  model: string;
  site: string;
  input: string;
  cap: number;
  run: number;
  outputTokens: number | null;
  reasoningTokens: number | null;
  textChars: number | null;
  error: string | null;
  /** The call site's own reading of the response. */
  outcome: string;
  /** True when the call site got a usable answer. */
  ok: boolean;
}

// Records the last response the wrapped provider returned, so each call-site
// result can be paired with its token usage.
class RecordingProvider implements LLMProvider {
  readonly id: string;
  last: LLMResponse | undefined;
  constructor(private readonly inner: LLMProvider) {
    this.id = inner.id;
  }
  async chat(params: Parameters<LLMProvider['chat']>[0]): Promise<LLMResponse> {
    this.last = await this.inner.chat(params);
    return this.last;
  }
}

function usageOf(res: LLMResponse | undefined): Pick<CallRecord, 'outputTokens' | 'reasoningTokens' | 'textChars' | 'error'> {
  if (!res) return { outputTokens: null, reasoningTokens: null, textChars: null, error: 'no call' };
  if (res.type === 'error') {
    return { outputTokens: res.usage?.outputTokens ?? null, reasoningTokens: res.usage?.reasoningTokens ?? null, textChars: null, error: res.error.message };
  }
  return {
    outputTokens: res.usage.outputTokens,
    reasoningTokens: res.usage.reasoningTokens ?? null,
    textChars: (res.content ?? '').length,
    error: null,
  };
}

function factGatePrompt(text: string): string {
  // Same wording as the extract-facts classifier gate (skills/extract-facts/handler.ts).
  return `Does the following text assert an attribute, fact, or characteristic about a single entity (for example: a person, organisation, project, event, or other entity — such as where they are located, their role, their status, or their preferences)? Answer only 'yes' or 'no'.\n\n${text}`;
}

// The verbatim 2026-06-01 leak body from tests/integration/outbound-judge.integration.test.ts.
const LEAK_BODY = [
  "Backend issues are preventing me from creating the calendar invite right now. Let me confirm with Armin and I'll circle back with the CEO about the invite.",
  '',
  "Armin — Friday June 5 at 2 PM works. Consider it locked in. I'll get a calendar invite over to you shortly.",
  '',
  "To the CEO: Both contacts and calendar specialists are returning errors — looks like a backend issue. I've confirmed Friday June 5 at 2 PM with Armin for coffee, but I'll need to get that invite out once things are back up. I'll keep an eye on it.",
].join('\n');
const CLEAN_BODY = "Friday June 5 at 2 PM works. I'll send a calendar invite shortly.";

async function measureModel(model: string, records: CallRecord[]): Promise<void> {
  const recorder = new RecordingProvider(new OpenRouterProvider(apiKey!, logger, registry));
  const router = new ModelRouter(
    { tiers: { fast: { model }, standard: { model }, powerful: { model } }, default_tier: 'fast' },
    registry,
    logger,
  );
  const classifier = new InfraLlmService(recorder, router, bus, logger, registry).scoped({ toolName: 'extract-facts' });
  const leakJudge = new OutboundLlmJudge(recorder, { enabled: true, model, timeoutMs: 15000, failMode: 'split' }, bus, logger, registry);
  const escalation = new EscalationJudge(recorder, { enabled: true, model, timeoutMs: 15000, reviewTimeoutMs: 15000 }, bus, logger, registry);
  const drift = new DriftDetector(recorder, { enabled: true, checkEveryNBursts: 1, minConfidenceToPause: 'high', model }, logger);

  type Case = { site: string; input: string; cap: number; run: () => Promise<{ outcome: string; ok: boolean }> };
  const cases: Case[] = [
    ...([
      ['fact', 'Priya Shah is the CFO of Northwind and is based in Toronto.', 'yes'],
      ['scheduling', "Can you move tomorrow's 3pm call to Thursday?", 'no'],
    ] as const).map(([input, text, expected]): Case => ({
      site: 'classifier',
      input,
      cap: 10,
      run: async () => {
        const r = await classifier.classify(factGatePrompt(text));
        if (!r.ok) return { outcome: `failed: ${r.error ?? 'unknown'}`, ok: false };
        const answer = r.text.trim().toLowerCase();
        return { outcome: answer || '(empty)', ok: answer.startsWith(expected) };
      },
    })),
    ...([
      ['leak', LEAK_BODY, true],
      ['clean', CLEAN_BODY, false],
    ] as const).map(([input, content, shouldFlag]): Case => ({
      site: 'leak-judge',
      input,
      cap: 200,
      run: async () => {
        const findings = await leakJudge.review({
          content,
          recipients: [{ email: 'armin@external.com', isPrincipal: false }],
          principalIncluded: false,
          principalIsSoleRecipient: false,
          conversationId: `measure-${input}`,
          channelId: 'email',
        });
        const rules = findings.map((f) => f.rule);
        const flagged = rules.includes('llm-judge-audience-leak');
        // In split mode a failed verdict shows up as a different rule, so check the rule, not just a finding.
        return { outcome: rules.join(',') || '(pass)', ok: rules.every((x) => x === 'llm-judge-audience-leak') && flagged === shouldFlag };
      },
    })),
    {
      site: 'disclosure-judge',
      input: 'calendar-detail',
      cap: 200,
      run: async () => {
        const v = await escalation.classifyDisclosure({
          content: 'Joseph is out of the office next week for a medical appointment on Tuesday.',
          recipientTier: 'known',
          conversationId: 'measure-disclosure',
        });
        return { outcome: `${v.decision}/${v.disclosureClass ?? 'none'}`, ok: v.disclosureClass !== undefined };
      },
    },
    {
      site: 'action-judge',
      input: 'email-third-party',
      cap: 300,
      run: async () => {
        const v = await escalation.classifyAction({
          description: 'Email the vendor at jane@vendor.com to confirm the revised contract terms.',
          initiatingTier: 'known',
          conversationId: 'measure-action',
        });
        return { outcome: `${v.decision}/${v.actionClass ?? 'none'}`, ok: v.actionClass !== undefined };
      },
    },
    ...([
      ['on-track', { task: 'Send the weekly sales pipeline summary to Joseph every Monday' }, 'Sent the pipeline summary email to Joseph with 12 open deals.', false],
      ['drifted', { task: 'Send the weekly sales pipeline summary to Joseph every Monday' }, 'Booked flights to Lisbon for the offsite and emailed three hotels for quotes.', true],
    ] as const).map(([input, payload, summary, expectDrift]): Case => ({
      site: 'drift-detector',
      input,
      cap: 200,
      run: async () => {
        const v = await drift.check({
          intentAnchor: 'Send Joseph a weekly summary of the sales pipeline.',
          taskPayload: payload,
          lastRunSummary: summary,
        });
        if (v === null) return { outcome: 'null (read as no drift)', ok: false };
        return { outcome: `drifted=${v.drifted}/${v.confidence}`, ok: v.drifted === expectDrift };
      },
    })),
  ];

  for (const c of cases) {
    for (let run = 1; run <= RUNS; run++) {
      recorder.last = undefined;
      const { outcome, ok } = await c.run();
      records.push({ model, site: c.site, input: c.input, cap: c.cap, run, ...usageOf(recorder.last), outcome, ok });
      const rec = records[records.length - 1]!;
      process.stdout.write(`${model}\t${c.site}\t${c.input}\t#${run}\tout=${rec.outputTokens}\treason=${rec.reasoningTokens}\t${ok ? 'OK' : 'FAIL'}\t${outcome}\n`);
    }
  }
}

const records: CallRecord[] = [];
for (const model of MODELS) {
  await measureModel(model, records);
}
writeFileSync(join(import.meta.dirname, 'results.json'), JSON.stringify({ measuredAt: new Date().toISOString(), runs: RUNS, records }, null, 2) + '\n');

process.stdout.write('\nmodel\tsite\tcap\tok/total\tmax out\tmax reasoning\n');
for (const model of MODELS) {
  for (const site of [...new Set(records.map((r) => r.site))]) {
    const rs = records.filter((r) => r.model === model && r.site === site);
    const maxOut = Math.max(...rs.map((r) => r.outputTokens ?? 0));
    const maxReason = Math.max(...rs.map((r) => r.reasoningTokens ?? 0));
    process.stdout.write(`${model}\t${site}\t${rs[0]!.cap}\t${rs.filter((r) => r.ok).length}/${rs.length}\t${maxOut}\t${maxReason}\n`);
  }
}
