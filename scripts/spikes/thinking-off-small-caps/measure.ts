// scripts/spikes/thinking-off-small-caps/measure.ts — #2224 measurement.
//
// Runs the real small-cap NO_REASONING call sites against OpenRouter models whose
// registry entry does not list `none`, and records whether each call returned an
// answer or spent its cap on thinking:
//   - the infra-llm classifier (10 tokens)
//   - the outbound leak judge (200)
//   - the escalation judge's disclosure (200), action (300) and band review (1,200)
//   - the drift detector (200)
//   - the extract-facts and extract-relationships extraction step (1,000)
//
// Each call goes through the call-site class itself (the extract cases through the
// skill handler), so the request carries the options production sends: NO_REASONING,
// which OpenRouterProvider leaves out for these models, so the model's default
// reasoning applies. Every tier maps to the model under test.
//
// Two things are recorded per call. `answered`: the call site got a verdict it could
// parse. `matched`: the verdict was the expected one, or null where the input has no
// single right answer. A judge that fails open (split mode returns no finding when
// unreachable) counts as not answered, from its outbound.judge outcome.
//
// Usage (bills OpenRouter; under $0.10 for the default run):
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
import type { ToolContext, ToolHandler } from '../../../src/skills/types.js';
import { createSilentLogger } from '../../../src/logger.js';
import { ExtractFactsHandler } from '../../../skills/extract-facts/handler.js';
import { ExtractRelationshipsHandler } from '../../../skills/extract-relationships/handler.js';

const MODELS = ['deepseek/deepseek-v4.1-flash', 'google/gemini-3.1-flash-lite'] as const;
const RUNS = Number(process.argv[2] ?? 3);

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  process.stderr.write('OPENROUTER_API_KEY is required\n');
  process.exit(1);
}

const logger = createSilentLogger();
const registry = new ModelRegistry(logger);

// Keeps the last outbound.judge outcome and reason code, so neither a fail-open judge
// nor a split-mode parse failure (judged_block / unparseable) is read as a verdict.
let lastJudge: { outcome?: string; reasonCode?: string } | undefined;
const bus = {
  publish: async (_layer: string, ev: { type: string; payload?: { outcome?: string; reasonCode?: string } }) => {
    if (ev.type === 'outbound.judge') lastJudge = { outcome: ev.payload?.outcome, reasonCode: ev.payload?.reasonCode };
  },
} as unknown as EventBus;

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
  /** The call site got a verdict it could parse. */
  answered: boolean;
  /** The verdict was the expected one; null where the input has no single right answer. */
  matched: boolean | null;
}

type Result = Pick<CallRecord, 'outcome' | 'answered' | 'matched'>;

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

const EXTRACT_TEXT =
  'Priya Shah, the CFO of Northwind, is based in Toronto and reports to Daniel Okafor, the CEO. '
  + 'She is vegetarian and is leading the Halcyon acquisition with Marcus Lee from Brightwater Capital.';

// Parses the extraction step's reply the way the handlers do: a JSON array, fences allowed.
function parsesAsJsonArray(text: string): boolean {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return Array.isArray(JSON.parse(body));
  } catch {
    return false;
  }
}

async function measureModel(model: string, records: CallRecord[]): Promise<void> {
  const recorder = new RecordingProvider(new OpenRouterProvider(apiKey!, logger, registry));
  const router = new ModelRouter(
    { tiers: { fast: { model }, standard: { model }, powerful: { model } }, default_tier: 'fast' },
    registry,
    logger,
  );
  const infraLlm = new InfraLlmService(recorder, router, bus, logger, registry);
  const classifier = infraLlm.scoped({ toolName: 'extract-facts' });
  const leakJudge = new OutboundLlmJudge(recorder, { enabled: true, model, timeoutMs: 15000, failMode: 'split' }, bus, logger, registry);
  const escalation = new EscalationJudge(recorder, { enabled: true, model, timeoutMs: 15000, reviewTimeoutMs: 15000 }, bus, logger, registry);
  const drift = new DriftDetector(recorder, { enabled: true, checkEveryNBursts: 1, minConfidenceToPause: 'high', model }, logger);

  // Runs a skill handler up to its extraction call. The classifier gate is answered
  // `yes` so the extraction always runs, and entity memory refuses writes: only the
  // extraction step's reply is measured.
  async function runExtraction(toolName: string, handler: ToolHandler): Promise<Result> {
    const scoped = infraLlm.scoped({ toolName });
    let extracted: { ok: boolean; text?: string } | undefined;
    const ctx = {
      input: { text: EXTRACT_TEXT, source: 'measure' },
      log: logger,
      entityMemory: new Proxy({}, { get: () => async () => { throw new Error('measure: no entity memory'); } }),
      infraLlm: {
        classify: async () => ({ ok: true, text: 'yes' }),
        extract: async (...args: Parameters<typeof scoped.extract>) => {
          const res = await scoped.extract(...args);
          extracted = res.ok ? { ok: true, text: res.text } : { ok: false };
          return res;
        },
      },
    } as unknown as ToolContext;
    await handler.execute(ctx);
    if (!extracted) return { outcome: 'extraction not reached', answered: false, matched: null };
    if (!extracted.ok) return { outcome: 'extraction call failed', answered: false, matched: null };
    const text = extracted.text ?? '';
    const answered = parsesAsJsonArray(text);
    return { outcome: answered ? 'json array' : text ? 'unparseable' : '(empty)', answered, matched: null };
  }

  type Case = { site: string; input: string; cap: number; run: () => Promise<Result> };
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
        if (!r.ok) return { outcome: `failed: ${r.error ?? 'unknown'}`, answered: false, matched: null };
        const answer = r.text.trim().toLowerCase();
        const answered = /^(yes|no)/.test(answer);
        return { outcome: answer || '(empty)', answered, matched: answered ? answer.startsWith(expected) : null };
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
        lastJudge = undefined;
        const findings = await leakJudge.review({
          content,
          recipients: [{ email: 'armin@external.com', isPrincipal: false }],
          principalIncluded: false,
          principalIsSoleRecipient: false,
          conversationId: `measure-${input}`,
          channelId: 'email',
        });
        // The bus callback sets it during review(); TypeScript cannot see that.
        const judged = lastJudge as { outcome?: string; reasonCode?: string } | undefined;
        const outcome = judged?.outcome
          ? `${judged.outcome}${judged.reasonCode ? `/${judged.reasonCode}` : ''}`
          : 'no outbound.judge event';
        // A parsed verdict is judged_pass, or judged_block with reason audience_leak.
        // Split mode also publishes judged_block for an unparseable reply (reason
        // unparseable), and failed_open / failed_closed for an unreachable judge.
        const answered = judged?.outcome === 'judged_pass'
          || (judged?.outcome === 'judged_block' && judged.reasonCode === 'audience_leak');
        const flagged = findings.some((f) => f.rule === 'llm-judge-audience-leak');
        return { outcome, answered, matched: answered ? flagged === shouldFlag : null };
      },
    })),
    {
      site: 'disclosure-judge',
      input: 'medical-appointment',
      cap: 200,
      run: async () => {
        const v = await escalation.classifyDisclosure({
          content: 'Joseph is out of the office next week for a medical appointment on Tuesday.',
          recipientTier: 'known',
          conversationId: 'measure-disclosure',
        });
        // No single right class for this input: record the verdict, not a match.
        return { outcome: `${v.decision}/${v.disclosureClass ?? v.reason}`, answered: v.disclosureClass !== undefined, matched: null };
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
        const answered = v.actionClass !== undefined;
        return { outcome: `${v.decision}/${v.actionClass ?? v.reason}`, answered, matched: answered ? v.isThirdPartyFacing === true : null };
      },
    },
    {
      site: 'band-review',
      input: 'leak-all-questions',
      cap: 1200,
      run: async () => {
        const v = await escalation.review({
          questions: ['purpose', 'speaks-as-principal', 'grounding', 'necessity'],
          message: LEAK_BODY,
          recipients: ['armin@external.com'],
          band: 'spot-check',
          evidence: {
            taskContent: 'Armin asked whether Friday June 5 at 2 PM works for coffee.',
            toolResults: [{ toolName: 'calendar-list-events', result: '{"error":"calendar service unavailable"}' }],
          },
          conversationId: 'measure-review',
        });
        return v.ok
          ? { outcome: `purpose=${v.purpose ?? '-'} unsupported=${v.unsupportedClaims?.length ?? 0}`, answered: true, matched: null }
          : { outcome: `failed: ${v.failure}`, answered: false, matched: null };
      },
    },
    ...([
      ['on-track', 'Sent the pipeline summary email to Joseph with 12 open deals.', false],
      ['drifted', 'Booked flights to Lisbon for the offsite and emailed three hotels for quotes.', true],
    ] as const).map(([input, summary, expectDrift]): Case => ({
      site: 'drift-detector',
      input,
      cap: 200,
      run: async () => {
        const v = await drift.check({
          intentAnchor: 'Send Joseph a weekly summary of the sales pipeline.',
          taskPayload: { task: 'Send the weekly sales pipeline summary to Joseph every Monday' },
          lastRunSummary: summary,
        });
        if (v === null) return { outcome: 'null (read as no drift)', answered: false, matched: null };
        return { outcome: `drifted=${v.drifted}/${v.confidence}`, answered: true, matched: v.drifted === expectDrift };
      },
    })),
    { site: 'extract-facts', input: 'cfo-paragraph', cap: 1000, run: () => runExtraction('extract-facts', new ExtractFactsHandler()) },
    { site: 'extract-relationships', input: 'cfo-paragraph', cap: 1000, run: () => runExtraction('extract-relationships', new ExtractRelationshipsHandler()) },
  ];

  for (const c of cases) {
    for (let run = 1; run <= RUNS; run++) {
      recorder.last = undefined;
      const result = await c.run();
      records.push({ model, site: c.site, input: c.input, cap: c.cap, run, ...usageOf(recorder.last), ...result });
      const rec = records[records.length - 1]!;
      process.stdout.write(
        `${model}\t${c.site}\t${c.input}\t#${run}\tout=${rec.outputTokens}\treason=${rec.reasoningTokens}\t`
        + `${rec.answered ? 'ANSWERED' : 'NO ANSWER'}\tmatched=${rec.matched}\t${rec.outcome}\n`,
      );
    }
  }
}

const records: CallRecord[] = [];
for (const model of MODELS) {
  await measureModel(model, records);
}
writeFileSync(join(import.meta.dirname, 'results.json'), JSON.stringify({ measuredAt: new Date().toISOString(), runs: RUNS, records }, null, 2) + '\n');

process.stdout.write('\nmodel\tsite\tcap\tanswered\tmatched\tmax out\tmax reasoning\n');
for (const model of MODELS) {
  for (const site of [...new Set(records.map((r) => r.site))]) {
    const rs = records.filter((r) => r.model === model && r.site === site);
    const graded = rs.filter((r) => r.matched !== null);
    const maxOut = Math.max(...rs.map((r) => r.outputTokens ?? 0));
    const maxReason = Math.max(...rs.map((r) => r.reasoningTokens ?? 0));
    const matched = graded.length > 0 ? `${graded.filter((r) => r.matched).length}/${graded.length}` : 'n/a';
    process.stdout.write(`${model}\t${site}\t${rs[0]!.cap}\t${rs.filter((r) => r.answered).length}/${rs.length}\t${matched}\t${maxOut}\t${maxReason}\n`);
  }
}
