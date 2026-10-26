# Authority-aware PII — PR 5: ask the principal instead of refusing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a linked or known requester asks for the principal's data and nothing authorizes it, the principal gets an immediate, actionable "Share it?" and the requester a holding reply. A yes sends the held message intact and counts as the principal's directive on that thread; a no stops further asks there. Cold strangers get a polite decline plus a digest note. Report items and the coordinator's sender facts state verification correctly.

**Architecture:** `BandSendReview` marks the PII holds that are asks (`ask: { labels }`). The gateway raises the approval with a question-first display and tells the agent to deliver it now and send a holding reply. `approve-action` / `deny-action` (and reaction approvals) write a `disclosure_decisions` row for ask approvals. The evidence collector reads those rows; a recorded yes is principal authority for that label to that counterparty on that thread, a no turns the ask into a bounce. Plus three carried fixes from PRs 3–4.

**Tech Stack:** TypeScript (ESM, Node 24), Postgres, Vitest.

**Spec:** `docs/wip/2026-10-26-authority-aware-pii-design.md` — "Asking the principal (failure 5)", decision 4. Issue #2312.

## Global Constraints

- Ask only when the requester is askable (PR 3/4 rules: recipient tier `known`/`trusted`, or a link to a principal-directed task covering every non-principal recipient). Never for cold, unlinked strangers.
- The approval display goes only to the principal; personal-details values may appear there (PR 3 line). Nowhere else: logs, events, digest items and `disclosure_decisions` hold labels only.
- A recorded yes authorizes exactly (conversation, counterparty, label). Nothing broader.
- No `any`; `.js` imports; typecheck + lint (0 warnings); `git commit -s`, **no** AI attribution. Next migration prefix after 107 (check `ls src/db/migrations | sort`).

## Review Focus

1. A yes recorded for `phone_us` to `bookings@acme.example` on thread T does not authorize `sin_ca`, another counterparty, or thread U (Task 2 tests).
2. A no on thread T: a later draft with the same label to the same counterparty bounces with "the principal declined"; a different label still asks (Task 2 tests).
3. An ask hold whose approval is approved replays intact (existing humanApproved path) **and** records the yes (Task 2 test).
4. A cold stranger's request: bounce + one digest note naming the label, never an approval (Task 1 test).
5. A trusted contact's explicit directive inside a principal-rooted task still sends with the principal copied at score 74 (Task 3 test).

---

### Task 1: Ask holds, question-first display, agent guidance, stranger digest note

**Files:** Modify `src/dispatch/band-send-review.ts`, `src/skills/outbound-gateway.ts` (`runBandReview` hold branch, `raiseSendApproval` preamble/extraLines), `skills/autonomy/tools/deliver-approval/tool.json` (description mentions PII asks are urgent; patch bump); Test band-send-review + gateway tests

**Interfaces (Produces):**
- Hold decision gains `ask?: { labels: string[]; requester: string }` — set when a hold comes **only** from PII items whose outcome is "hold → ask" (`inferred` below 80 under task authority, or `unsupported` + requested + askable). `requester` is the primary non-principal recipient identifier.
- Approval preamble for an ask (exact): `<requester> is asking for your <labels joined ' and ', using human labels: phone_us→phone number, phone_uk_mobile→mobile number, email→email address, credit_card→card number, ssn→SSN, sin_ca→SIN, extra_N→personal detail><for task: ' for "<task title>"' when known>. Share it? Reply yes to send the message below as written, or no to keep it private.` The PR 3 personal-details line and the draft follow as today.
- Agent-facing result for an ask hold (append to `blockedReason`, exact): `This is waiting on the principal. Deliver approval <ref/number> to them now with deliver-approval on their urgent channel, then send <requester> a short holding reply that doesn't include the requested details.`
- Bounce for `unsupported` + requested + **not** askable additionally queues one digest item via `queueBlockReport`: `<requester> asked for your <human labels>. Curia didn't share it and replied without it.` (labels only).
- [ ] Tests: ask hold carries `ask`; non-PII holds don't; display preamble text exact; result guidance exact; stranger bounce queues exactly one digest item, no approval row.
- [ ] FAIL → implement → PASS (`tests/unit/dispatch tests/unit/skills skills/autonomy`). Commit `feat(autonomy): held PII requests ask the principal directly (#2312)`.

### Task 2: `disclosure_decisions` — record yes/no, read them back

**Files:** Create `src/db/migrations/<next>_disclosure_decisions.sql`, `src/autonomy/disclosure-decisions.ts`; Modify `src/skills/outbound-gateway.ts` (store `ask` on the action_log row payload, e.g. `payload._disclosureAsk = { conversationId, counterparty, labels }`, or a dedicated column — pick the least invasive and keep it out of the replayed skill input), `skills/autonomy/tools/approve-action/handler.ts`, `skills/autonomy/tools/deny-action/handler.ts`, `src/autonomy/reaction-approval-mapper.ts`, `src/autonomy/send-evidence.ts`, `src/dispatch/band-send-review.ts`, `src/dispatch/task-outreach.ts` (learn on yes), `src/index.ts`; Tests beside each + integration test

**Interfaces (Produces):**
```sql
CREATE TABLE disclosure_decisions (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  counterparty TEXT NOT NULL,      -- lowercased recipient identifier
  label TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('yes','no')),
  decided_by TEXT NOT NULL,        -- 'principal'
  action_ref TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);  -- index on (conversation_id, counterparty, label, created_at DESC)
```
```ts
export class DisclosureDecisionsRepo {
  record(rows: Array<{ conversationId: string; counterparty: string; label: string; decision: 'yes'|'no'; actionRef?: string }>): Promise<void>
  latestFor(conversationId: string, counterparties: readonly string[]): Promise<Array<{ counterparty: string; label: string; decision: 'yes'|'no' }>>  // latest per (counterparty,label)
}
```
- approve-action / reaction approval of a row carrying a disclosure ask → record `yes` for each (counterparty, label), then replay as today; also `learnCounterparty` on the linked outreach row if the send was linked (PR 4 rule "or after the principal says yes"). deny-action → record `no`. dismiss-action → nothing.
- Collector: `CollectedEvidence.decisions?: Array<{ counterparty; label; decision }>` for the send's conversation and recipients (internal; render to the judge only as "the principal already said yes/no to sharing <label> with this recipient on this thread").
- Policy: for an item whose label has a latest `yes` for **every** non-principal recipient → outcome send (principal directive), regardless of the judge's basis. A latest `no` for any non-principal recipient → bounce with detail `The principal declined sharing your <label> with this recipient on this thread. Rewrite without it.` and never ask again (overrides "hold → ask").
- [ ] Tests (Review Focus 1–3), repo unit + integration, approve/deny/reaction handlers record correctly and only for ask rows.
- [ ] FAIL → implement → PASS. Commit `feat(autonomy): the principal's yes or no on a PII ask is remembered per thread (#2312)`.

### Task 3: Carried fixes from PRs 3–4

**Files:** `src/dispatch/band-send-review.ts` (`authorityOf`), `src/dispatch/outreach-matcher.ts`, `src/channels/email/message-converter.ts` + `src/dispatch/dispatcher.ts` (`curiaRecipientAddress`); tests beside each

- **Trusted directive ordering** (decision 2): when the drafting turn's own originator qualifies as trusted (stamped + current trusted + authenticated), a `directed` ruling takes the trusted path (send + copy principal at any score) even if a bound/root/linked task also gives `principal-task`. Test (Review Focus 5).
- **Matcher cross-step preference:** run all three direct steps (address, contact, org-domain); prefer the first match on a **confirmed** row across steps; fall back to the first unconfirmed hit only if no confirmed match exists. Tests: unconfirmed address hit + confirmed domain match → strong via domain.
- **Matched mailbox:** the email converter publishes `curiaMailbox` in metadata only when Curia's own address is in To (exact, normalized); `curiaRecipientAddress` reads it and returns undefined otherwise (BCC, alias, CC). Fix the doc comment. Tests including Curia absent from To and CC.
- [ ] FAIL → implement → PASS. Commit `fix(autonomy): trusted directives keep the copy path; outreach matching prefers confirmed rows (#2312)`.

### Task 4: Sender facts stated correctly

**Files:** `src/agents/runtime.ts` (~1115-1120 sender block), any gateway-written report summaries that describe sender verification; tests in `tests/unit/agents/`

- Replace the bare `senderVerified: <bool>` line with two explicit lines (exact):
  - `Contact identity: <verified|not verified> (whether this address is confirmed as belonging to this contact)` — from the resolved sender's identity `verified` flag.
  - `Message authentication: <passed|failed|not available> (SPF/DKIM/DMARC for this message)` — from `metadata.senderVerified` (email only; `not available` on other channels).
- Keep the coordinator guardrail that keys on `senderVerified` working (update its wording/reference in agents/coordinator.yaml if it names the old line; bump version; stay within the prompt budget — net zero or smaller).
- [ ] Tests: verified contact + failed authentication renders both facts distinctly; non-email renders `not available`.
- [ ] FAIL → implement → PASS (`tests/unit/agents`, prompt-budget test). CHANGELOG (Added: principal asked directly for held PII requests; yes/no remembered per thread. Fixed: sender verification facts stated separately.) Commit `fix(agents): sender identity and message authentication stated separately (#2312)`.
