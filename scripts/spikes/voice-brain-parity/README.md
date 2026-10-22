# Voice brain parity spike harness (#1595 / ADR-038, #1968)

```bash
# Single run (arms: baseline, shared-hardening, slim-core)
ANTHROPIC_API_KEY=… pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts

# Variance (≥5 interleaved reps) — prefer variance.json over a point estimate
ANTHROPIC_API_KEY=… REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts

# Pick arms; ADR-038's full-consolidation arm is off by default
ARMS=baseline,full-consolidation REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts

# Latency: arms × tool sets (none / voice / coordinator), cold and warm
ANTHROPIC_API_KEY=… REPS=10 pnpm exec tsx scripts/spikes/voice-brain-parity/latency-microbench.ts
```

Since #1968 every arm gets what production assembles (`production-context.ts`): the
specialist roster from `agents/`, voice's real tool definitions (`VOICE_TOOL_NAMES`),
and, for `slim-core`, the coordinator's per-turn system string from `assembleAgent` +
`buildBaseSystemPrompt`. No database is needed.

Committed artifacts: `fixtures.json`, `variance.json` (latest multi-rep summary),
`latency-microbench.json`. `results.json` is regenerated locally (gitignored when large).
