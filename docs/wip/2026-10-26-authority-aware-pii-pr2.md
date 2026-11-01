# Authority-aware PII — PR 2: judge fixes and no more cut-and-send

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Band review never delivers a cut-down message, never flags Curia's own conduct as an unsupported claim about the principal, never treats content to the principal as a disclosure, doesn't count Curia's own addresses as recipients, and sees what Curia reported to the principal this turn.

**Architecture:** `BandSendReview.review()` loses its trim branch: a finding that survives the one bounce holds below 80 and becomes a new `block` decision at 80+. The brief learns which recipients are the principal and what was reported to the principal. The gateway drops Curia's own email addresses from the recipient set before computing "principal is the sole recipient".

**Tech Stack:** TypeScript (ESM, Node 24), Vitest, Postgres (one repo query).

**Spec:** `docs/wip/2026-10-26-authority-aware-pii-design.md` — decision 8 and "Judge fixes (failures 2, 3, 6)". Issue #2312.

## Global Constraints

- Band behavior only (`autonomy.gating: band`); tier gating unchanged except Task 3's recipient-set change, which feeds both.
- No `any`; `.js` imports; no empty `catch {}`; comments match the file's existing density.
- `pnpm -C <worktree> run typecheck` + `pnpm -C <worktree> lint` before each commit; `git commit -s`; **no** AI attribution trailer.
- CHANGELOG `## [Unreleased]` bullets ≤15 words after the em-dash.
- The judge prompt is model-facing text: keep additions short and concrete.

## Review Focus

1. A draft that bounces, is rewritten, and still has findings at 80+ is **not sent** and is not silently dropped: the agent gets an error, and a relayed reply (no agent waiting) leaves a digest report (Task 1 test).
2. After a `block`, a third draft on the same thread within the TTL is blocked again unless clean — no unbounded bounce loop (Task 1 test).
3. "To: Curia's own address, CC: principal" → principal is the sole recipient: no band review, no redaction (Task 3 test).
4. A message to the principal plus a third party: the brief marks the principal recipient so necessity applies only to the third party (Task 2 test on the prompt).
5. Reports written by `report-to-principal` in the drafting turn reach the judge's evidence; a relayed reply's cut-out principal note reaches the review of that relay (Task 4 tests).

---

### Task 1: Remove cut-and-send; add a `block` decision

**Files:**
- Modify: `src/dispatch/band-send-review.ts` (header comment; delete `MIN_TRIM_QUOTE_CHARS`, `removeQuoted`, the trim + recheck branch; `BandReviewReport.source` becomes `'sent_without_review'` only; new decision kind)
- Modify: `src/skills/outbound-gateway.ts` (`runBandReview` ~1952-2072: delete the `!editable` trim→hold conversion ~1988; handle `block`; spot-check `review: 'trimmed'` mapping ~1914)
- Modify: `src/bus/events.ts:1767` and `src/reports/report-queue.ts:44` — keep `claim_trimmed` in the source union with a "no longer emitted (#2312); kept for historical audit rows" comment, like `principal_note`
- Modify: `docs/specs/14-autonomy-engine.md:327` row and ADR-049's "trim at 80+" sentence (`docs/adr/049-band-driven-autonomy.md`): one-bounce rewrite, then hold below 80 / not sent at 80+
- Test: `tests/unit/dispatch/band-send-review.test.ts`, `tests/unit/skills/outbound-gateway.test.ts`

**Interfaces:**
- Produces: `BandReviewDecision` gains `| { kind: 'block'; reason: string; findings: FilterFinding[] }`.
- `BLOCK_REASON` text (exact): `'Not sent: after one rewrite it still has the problems below. Rewrite it again without them, or tell the principal.'` — the gateway appends `buildBlockReasonSummary(findings)`.

- [ ] **Step 1: Write failing tests** (band-send-review):
  - second occurrence of claims or items at score 84 → `{kind:'block'}` with the findings (rules `ungrounded-claim` / `unneeded-disclosure`), and the judge was called exactly twice (no grounding-only recheck call).
  - same at score 74 → `{kind:'hold'}` (unchanged).
  - after a `block`, a third review on the same key with findings → `block` again (the bounce ledger entry is kept and its time refreshed on block); a clean third draft → `send` and the entry is cleared.
  - **incident drafts**, each fed with a judge flagging the given sentence twice, at 84 → `block`, at 74 → `hold`, never `send`:
    - `"Thanks for reaching out. I can't share Sam's contact details at this point. If you'd like, I can pass your note along to him."` flagged `"I can't share Sam's contact details at this point."`
    - `"Thanks for following up. I've passed your request along to Sam; he'll reach out directly this week."` flagged `"he'll reach out directly this week."`
    - `"Email is the best route to Sam: sam@example.com. Send a couple of times that suit you and he will confirm one."` flagged `"Send a couple of times that suit you and he will confirm one."`
  - no export named `removeQuoted` remains (delete its tests).
- [ ] **Step 2: Write failing gateway tests:** a `block` decision → `{success:false, blockedReason}` starting with `BLOCK_REASON`, `blockedRules` = finding rules, nothing dispatched, **no** `outbound.blocked` published (avoids the #1355 relay rewrite loop), and one `queueBlockReport` digest item (so a relayed reply's block reaches someone). A saved draft (`sendEmailDraft`) bounce/hold paths unchanged.
- [ ] **Step 3: Run** `pnpm -C <worktree> exec vitest run tests/unit/dispatch/band-send-review.test.ts tests/unit/skills/outbound-gateway.test.ts` → FAIL.
- [ ] **Step 4: Implement.** Update existing tests that asserted trims (`claim_trimmed` sends, `review: 'trimmed'`) to the new outcomes.
- [ ] **Step 5: Run** the two files plus `tests/unit/reports tests/unit/bus` → PASS; typecheck; lint.
- [ ] **Step 6: Commit** `feat(autonomy): band review rewrites instead of cutting; block at 80+ (#2312)`.

### Task 2: Brief scope — Curia's own conduct; content to the principal

**Files:**
- Modify: `src/autonomy/judge-brief.ts` (`BriefInput`, `BRIEF_SYSTEM_PROMPT`, `buildBriefUserPrompt`)
- Modify: `src/dispatch/band-send-review.ts` (`BandReviewInput`, pass-through in `ask`)
- Modify: `src/skills/outbound-gateway.ts` (`runBandReview` args and both callers: `send()` ~1380 and `sendEmailDraft` ~3387)
- Test: `tests/unit/autonomy/judge-brief.test.ts`, `tests/unit/dispatch/band-send-review.test.ts`, `tests/unit/skills/outbound-gateway.test.ts`

**Interfaces:**
- `BriefInput.principalRecipients?: readonly string[]` and `BandReviewInput.principalRecipients?: readonly string[]` — the subset of `recipients` that are the principal (from `buildFilterRecipients`/`buildRecipientSet` entries with `isPrincipal`).
- Prompt additions (exact):
  - in the `unsupportedClaims` bullet, append: `Statements about what the assistant itself is doing, has done, can or cannot do, or will do ("I can't share that", "I'll pass this along", "I've passed your request on") are about the assistant, not the principal: never list them.`
  - in the `unnecessaryItems` bullet, append: `Anything going to the principal is never an unnecessary disclosure; judge only what the other recipients receive.`
  - user prompt line after Recipients: `Of these, the principal: <principal_recipients_json>…</principal_recipients_json>` (encoded like the others).

- [ ] **Step 1: Write failing tests:** `buildBriefUserPrompt` with `principalRecipients: ['sam@example.com']` contains `<principal_recipients_json>["sam@example.com"]</principal_recipients_json>`; without it, the tag holds `[]`. `BRIEF_SYSTEM_PROMPT` contains both added sentences. `BandSendReview` forwards `principalRecipients` to `judge.review`. Gateway: a send To principal + CC third party passes `principalRecipients: [principal address]` to `bandReview.review`.
- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck; lint.
- [ ] **Step 5: Commit** `fix(autonomy): judge ignores Curia's own conduct and content to the principal (#2312)`.

### Task 3: Curia's own addresses are not recipients

**Files:**
- Modify: `src/skills/outbound-gateway.ts` (`finalizeRecipientSet` ~2655; band review `recipients` argument in `send()` ~1380 and `sendEmailDraft`)
- Test: `tests/unit/skills/outbound-gateway.test.ts`

**Interfaces:**
- `finalizeRecipientSet` drops any recipient whose identifier equals (case-insensitive) a value of `emailAccountAddresses`, before dedup and the principal flags. The returned `recipients` excludes them too.
- Band review's `recipients` = the finalized set's identifiers (no longer `personRecipients(request)`), so the judge never sees Curia's own mailbox as an audience.

- [ ] **Step 1: Write failing tests** (gateway with `emailAccountAddresses: new Map([['curia','curia@example.com']])`, band gating, a `bandReview.review` mock, real `PiiRedactor` with a phone number in the body):
  - To `curia@example.com`, CC principal → `bandReview.review` not called; body delivered intact (redactor bypass).
  - To `Curia@Example.com` (case), CC principal → same.
  - To third party, CC `curia@example.com` → `review` called with `recipients` not containing `curia@example.com`.
  - To `curia@example.com` only → not principal-sole (review runs or the existing non-principal path applies; assert `principalIsSoleRecipient` false via review being called).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the gateway test files (`tests/unit/skills/outbound-gateway*.test.ts`, `tests/unit/dispatch/outbound-gateway-archive.test.ts`) → PASS; typecheck; lint.
- [ ] **Step 5: Commit** `fix(outbound): Curia's own addresses don't count as recipients (#2312)`.

### Task 4: What Curia reported to the principal is evidence

**Files:**
- Modify: `src/audit/audit-log-repo.ts` (new query beside `findToolResultsForTasks` ~495)
- Modify: `src/autonomy/send-evidence.ts` (`collect`), `src/autonomy/judge-brief.ts` (`BriefEvidence`, prompt)
- Modify: `src/dispatch/band-send-review.ts` (`BandReviewInput.reportedToPrincipal`), `src/skills/outbound-gateway.ts` (send option → `runBandReview`), the dispatcher relay call site in `src/dispatch/dispatcher.ts` that sends the relayed reply (it has `event.payload.principalNote`)
- Test: `tests/unit/audit/audit-log-repo-tool-results.test.ts` (or a sibling), `tests/integration/audit-log-tool-results.test.ts` (add a case; runs only with Docker Postgres), `tests/unit/autonomy/send-evidence.test.ts`, `tests/unit/autonomy/judge-brief.test.ts`, `tests/unit/dispatch/band-send-review.test.ts`, the dispatcher unit test that covers relays with a principal note

**Interfaces:**
- `AuditLogRepo.findPrincipalReportsForTasks(taskEventIds: readonly string[], limit: number): Promise<AuditLogRow[]>` — `event_type = 'principal.report'` and `parent_event_id = ANY($1)`, newest first.
- `BriefEvidence.reportsToPrincipal?: readonly string[]` (summaries, clipped to `EVIDENCE_RESULT_MAX_CHARS`, secrets redacted like other evidence, newest first, at most 10).
- `OutboundSendOptions.reportedToPrincipal?: string` → `BandReviewInput.reportedToPrincipal?: string`; `BandSendReview.ask` appends it to `evidence.reportsToPrincipal`.
- Prompt: user-prompt line `Reported to the principal this turn: <reports_json>…</reports_json>`; system-prompt sentence in the evidence paragraph: `What the assistant reported to the principal this turn counts as support for saying it told or passed something to the principal.`

- [ ] **Step 1: Write failing tests:** repo unit test asserts the SQL filters `event_type = 'principal.report'` and `parent_event_id = ANY`; collector returns `reportsToPrincipal` from the rows' `payload.summary` (and `[]`/absent when none; a repo throw makes `unavailable: true` as today); prompt renders the tag; review appends `reportedToPrincipal`; dispatcher relay of a response with `principalNote: 'Provider asked for your number.'` passes `reportedToPrincipal: 'Provider asked for your number.'` to the gateway send.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched unit files → PASS; run the integration file only if Docker Postgres is available (say in the report either way); typecheck; lint.
- [ ] **Step 5: CHANGELOG** (Changed: band review rewrites instead of cutting; Fixed: judge flags Curia's own conduct / disclosures to the principal / Curia's own mailbox) and commit `feat(autonomy): reports to the principal count as judge evidence (#2312)`.
