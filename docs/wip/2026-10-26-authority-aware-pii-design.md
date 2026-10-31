# Authority-aware PII disclosure — design

**Status:** draft 2026-10-26. Tracking issue: #2312. Builds on #2159 (band review) and
borrows #2192 Part 2's harness work.

Issue #2312 records the incident, the six failures and the first design. This document holds
the decisions made since, the plan for each part, and what is left to the builder. Where it
differs from the issue, this document wins.

## Intent

Whether a disclosure is OK depends on **who authorized it and why**, not on whose data it is.
The band judge decides that per detected item. Curia must never tell the principal it shared
something it did not. When nobody has authorized a disclosure that a legitimate counterparty
needs, Curia asks the principal right away instead of refusing.

### Goals

- Every detected PII item that would be redacted today, under `gating: band`, is ruled on by
  the judge before anything is removed.
- The judge knows who gave the directive behind a send, on what channel, whether that channel
  authenticated them, and the task (and root task) the send serves.
- A reply from a counterparty Curia contacted for a task, through any route (email, web form),
  arrives knowing its task.
- No hollow, truncated or `[REDACTED: …]` message is ever delivered under band gating.
- The agent always learns what was removed or refused, and why.

### Non-goals

- Exempting the principal's own identities from redaction (rejected in the issue).
- Detecting health card numbers or birthdates (too many formats).
- Storing sensitive identifiers so Curia "already has them" (#1358).
- Changing `principalDirected` semantics for gates other than band review.
- Changing tier gating behavior beyond redaction reporting (decision 5).

### Anti-goals (a failure even if it "works")

- A stranger, or text quoted inside a forwarded email, gets PII by claiming authority.
- A link between a reply and a task raises the sender's tier or grants authority by itself.
- The principal is paged for every phishing attempt.
- The PII step is weakened on judge failure (it must fail closed).

## Decisions (with the principal, 2026-10-26)

1. **A detail the judge won't approve is rewritten by the agent, never cut out.** The draft
   bounces to the drafter with the label and the reason, and the drafter rewrites without it.
   If the rewrite still carries an unapproved item, the send does not go out: the agent gets
   an error saying so, and may ask the principal (decision 4). No sentence cutting is done for
   PII and no `[REDACTED: …]` token is delivered under band gating.
2. **A trusted contact's explicit directive skips the hold at any score**, including 74.
   Conditions: the directive names the data and the recipient, it comes from a `trusted`
   contact, and it arrives on an **authenticated channel**: Signal, Slack, or email with
   `senderVerified` (SPF + DKIM + DMARC pass). SMS and voice do not count. The other band
   checks (grounding, speaks-as-principal, purpose) still apply. The principal is copied (cc
   on email; an `urgency: 'now'` report item on other channels).
3. **Reply-to-task linking uses organization signals first, then a light model check.** See
   "Linking replies to their task". A link gives the reply its task as context and as judge
   evidence. It never raises the sender's tier and never grants authority by itself. The
   judge sees how the link was made.
4. **Immediate asks go only to requests from linked or known requesters.** When no directive
   covers a third party's request for the principal's data, the principal gets an immediate,
   actionable ask *only if* the requester is linked to a task the principal directed, or is a
   `known` or `trusted` contact. A cold, unlinked stranger gets a polite decline and a digest
   note.
5. **Under `gating: tier`, only redaction reporting applies.** Everything else is band-only.
   The notes for #2192 are posted there when this lands.
6. **Scenario runs during this work cover only the new cases**, never the full release gate.
   Ask before each paid run, with a cost estimate.
7. **Only strong links unlock an inferred disclosure.** A *strong* link is same address, a
   known counterparty contact, or the organization's own domain with an authenticated sender.
   A *weak* link is a model-inferred match or an unauthenticated sender. A weak link never
   unlocks sharing at any score; it only makes the requester askable (the immediate ask).
8. **No cutting, anywhere.** Cut-and-send is removed from band review entirely, for PII,
   ungrounded claims and unneeded details alike. Every finding bounces to the drafter for a
   rewrite. If the finding survives the one rewrite: hold below 80, block (refuse, agent told
   why) at 80+. This supersedes the issue's "cuts must leave a complete message": no cut
   output can be hollow or truncated because none is produced.

## The PII flow under band gating

Today Step 1.5 (`outbound-gateway.ts:1155-1216`) redacts before the content filter and band
review, so the judge only sees tokens. The new order is **detect, then decide, then act**.

### Step 1.5 becomes detection (band) or redaction (tier)

- Split `PiiRedactor` into `detect(content, channelId, ctx)` and `apply(content, items)`.
  `detect` keeps today's checks (enabled flag, principal bypass, channel allow list) and
  returns only the items that would have been redacted: `{ id, label, start, end, matched }`.
  `redact()` stays as `detect` plus `apply` for tier gating and for fallbacks.
- Detection runs on the body **and** the subject. Subject items go to the judge too (the
  judge now sees the subject).
- Under tier gating, Step 1.5 behaves exactly as today, plus reporting (below).
- Fix the principal bypass: use the recipient set the filter already builds
  (`buildFilterRecipients`), not the primary To contact alone. The bypass applies when the
  principal is the sole human recipient (see "Curia's own addresses"). Today "To: principal,
  cc: third party" skips redaction, so PII reaches the third party. This is a leak fix and
  lands in **both** gating modes, in PR 1 *(builder's call: decision 5 limits new behavior
  under tier, not leak fixes)*.
- `sendEmailDraft` (~3156) gets the same detection and decision path. Today it skips
  redaction entirely. Drafts can't bounce (`editable: false`), so any outcome other than
  "send" holds, as the draft path already does for trims. Principal-directed drafts skip band
  review entirely today (~3396); they get a new disclosure-only review when detected items
  exist. Under tier, drafts get plain redaction like `send()`.
- **The content filter's Stage 2 judge keeps seeing the redacted copy**: detection produces
  both the raw body (for band review) and a redacted copy (for the filter), so Stage 2's model
  never sees raw values. A Stage 2 block still wins over any disclosure ruling *(builder's
  call)*.
- **Which approved sends pass detected items.** A `humanApproved` send passes its detected
  items intact only when it is the replay of an `autonomy_action_log` approval (any hold
  reason) whose display showed the full body. Other `humanApproved` sources (`send-draft`,
  which sets it on every call; dispatcher relays) go through detection and the disclosure
  review like any send. The builder confirms the display shows the full body and makes it do
  so if not *(builder's call)*. Under tier, approved replays are redacted as today.

### What the judge sees and rules

The band brief gets a new question, `disclosure`, asked whenever detected items exist,
**including principal-directed sends** (which today get `grounding` only). The judge sees:

- the raw message and subject (the drafter already saw the values; the judge already sees
  PII in tool-result evidence);
- the list of detected items: id, label, and the exact matched text;
- the authority evidence (next section).

For each item the judge answers `{ id, basis, requested, reason }`:

- `basis: 'directed'`: an explicit directive covers this data going to this recipient.
  A principal forwarding a counterparty's request and saying "go ahead" counts as directed.
- `basis: 'inferred'`: the purpose of a principal-directed task implies it (sharing a phone
  number to book a call the principal asked for).
- `basis: 'unsupported'`: Curia's own initiative, a task started by someone else, a recipient
  outside the task, or authority claimed only in forwarded or quoted text.
- `requested`: whether the recipient asked for this data.

Malformed or missing answers for any item count as a judge failure.

### What the gateway does with the rulings

Deterministic policy, in `band-send-review.ts`:

| Ruling | Who directed | Score ≥ 80 | Score < 80 |
|---|---|---|---|
| `directed` | principal (live turn, task text, or a recorded "yes") | send | send |
| `directed` | trusted contact on an authenticated channel | send + copy principal | send + copy principal |
| `directed` | anyone else | treat as `unsupported` | treat as `unsupported` |
| `inferred` | a principal-directed task (live or standing), the send's own task or a **strong** link | send | hold → ask (decision 4 path) |
| `inferred` | a principal-directed task reached only by a **weak** link | hold → ask | hold → ask |
| `inferred` | anything else | treat as `unsupported` | treat as `unsupported` |
| `unsupported`, `requested`, requester askable | — | hold → ask | hold → ask |
| `unsupported`, otherwise | — | bounce: rewrite without it | bounce: rewrite without it |

- "Who directed" is computed by code from the evidence (originator tier, system role,
  channel authentication), not taken from the judge. The judge's `directed` is only accepted
  for an authority the code confirms exists.
- "Requester askable" (decision 4) is code: the recipient is linked to a principal-directed
  task, or the recipient contact's tier is `known` or `trusted`.
- A bounce counts against the existing one-bounce-per-draft ledger. A second unapproved item
  after the bounce is a block (not a hold, not a cut): the agent is told the item can't be
  sent and, when the requester is askable, that it can ask the principal.
- A "no" recorded for this thread and label (see "Asking the principal") turns `hold → ask`
  into a bounce with "the principal declined sharing X on this thread".
- The other band rules run as today on the same verdict. The strictest outcome wins:
  block > hold > bounce > send.
- **`necessity` no longer covers detected items.** The brief tells the judge that detected
  items are ruled under `disclosure` only, and `unnecessaryItems` that overlap a detected
  item's span are dropped.
- **A trusted contact's authority** is checked by code at send time: the originator's
  stamped tier *and* the contact's current tier are both `trusted` (a demoted contact loses
  it), the originating message was authenticated, and the send is in the live turn or a task
  that contact created. The judge must rule `directed`, i.e. the directive explicitly names
  the data and recipient *(builder's call)*.

### Judge failure (fail closed)

If the judge fails, times out, or is skipped, every detected item is treated as
`unsupported` and not askable: the draft bounces for a rewrite without them. Checking that the
rewrite has no detected items is deterministic and needs no judge. This replaces "fall back to
today's redaction" from the issue, because tokens must not be delivered (decision 1). The
existing fail-open limiter for the other questions at 80+ is unchanged, but it never lets a
detected item through.

### Redaction tokens are a defect

Any `[REDACTED: …]` token in an outgoing body or subject, under band gating, bounces to the
drafter (first time) or blocks (after the bounce), with an explanation. This catches a drafter
that copies a token from earlier context.

### Reporting to the agent (ships first; both gating modes)

- `OutboundSendResult` gains `redactions?: { label: string; field: 'body' | 'subject' }[]`
  (labels only, never values), set whenever the delivered content differs from the draft
  because of redaction.
- A shared `redactionData(result)` helper next to `relayDeferredData` is spread into the
  success `data` of `email-send`, `email-reply`, `signal-send`, `sms-send`, `slack-send` and
  `send-draft`, with a short `note` telling the agent not to claim it shared those items.
- Bounce and block results name the labels and the reason in the error text.
- `registerOutboundContext` and `outbound_context.content_preview` store what was
  delivered, not the draft.

## Authority evidence for the judge

`SendEvidenceCollector.collect` already loads the `agent.task` row. It adds:

- **originator**: `contactId`, `systemRole`, `tier`, `channel`, from `metadata.originator`;
- **authenticated**: whether the originating message authenticated its sender
  (`inboundSenderAuthenticated` semantics). `stampOriginator` records a new optional field
  `TaskOriginator.authenticated` at stamp time, so task wakes and child tasks carry it
  (JSONB, no migration). `capOriginatorToParent` picks the whole child or parent originator
  by `systemRole` rank, so `authenticated` travels with whichever is chosen; a missing field
  reads as `false`.
- **liveTurn**;
- **task**: the bound task's title and description (`boundTask.taskId`), and the **root
  task** (`resolveProjectRootTaskId`) with its title, description and originator, for
  standing-task and child-task sends;
- **link**: for a reply linked to a task (below): the task, the root task, and `linkKind`;
- **principal decisions**: recorded "yes"/"no" disclosure decisions for this thread;
- **report items**: `principal.report` rows written by this task's turns
  (`audit_log`, same task event ids), so "I've passed your request along" is grounded.

The brief renders these as an "Authority" block. Text inside forwarded or quoted content is
labelled as such and the brief states it grants no authority.

## Judge fixes (failures 2, 3, 6)

- **Grounding covers claims about the principal, not Curia's own conduct.** The brief says
  statements about what Curia is doing or will do ("I can't share…", "I'll pass this along")
  are not principal claims. Report items from the turn are evidence.
- **Reporting to the principal is never a disclosure.** `unneeded-disclosure` and the
  `disclosure` question never apply to content whose only human recipient is the principal.
  When the principal is one recipient among others, the brief judges the other recipients
  only.
- **Curia's own addresses are not recipients.** `finalizeRecipientSet` drops Curia's own
  identities (email account addresses, Curia's Signal number, etc.) before
  `computePrincipalIsSoleRecipient`, so "to: Curia, cc: principal" is principal-only. The
  relay budget sees the same set.
- **No cuts (decision 8).** `removeQuoted`, the trimmed-recheck path, `MIN_TRIM_QUOTE_CHARS`
  and the `claim_trimmed` report source are removed. The second-occurrence branch in
  `BandSendReview.review()` becomes: score < 80 → hold; score ≥ 80 → block with the findings
  in the error, so the agent can rewrite again, ask the principal, or tell them. The draft
  path's "trim → hold" conversion goes away with it. Unit tests feed this incident's three
  drafts (the two refusals flagged `ungrounded-claim`, and the 13:36 email) and assert a
  bounce, then hold or block, and never a delivered fragment. ADR-049 and spec 14's
  "trim at 80+" text are corrected.

## Linking replies to their task (failure 1)

### Outreach records

A new table, `task_outreach` (migration):

| Column | Meaning |
|---|---|
| `id`, `task_id`, `root_task_id` | the task the outreach served |
| `originator` | JSONB copy of the task's originator at outreach time |
| `via` | `email`, `web_form`, `signal`, … |
| `org_name` | the organization contacted, when known |
| `domains` | known domains: website, form host, email domains |
| `addresses` | counterparty addresses known so far (learned on link) |
| `contact_ids` | counterparty contact UUIDs, when resolved |
| `given_contact` | the reply address or number Curia gave on a form |
| `summary` | one line: what was asked ("book a 30-min intro call for the principal") |
| `created_at`, `closed_at`, `expires_at` | open while the task is open; 30-day cap |

A "task-bound turn" here means `boundTask` (a wake), a linked reply (`linkedTask`), **or a
live principal turn**. `task_id` is nullable: outreach from a live principal turn with no
durable task records `task_id = null`, the principal originator, the `conversation_id` and the
directing `agent.task` event id, so the judge can read the principal's words later
*(builder's call)*.

Writers:

- **Email and other sends on a task-bound turn** add or update a row from the recipients. This sits beside the existing `bind_reply` outbound-context
  write, not in place of it.
- **A new `record-outreach` tool** for outreach without a recipient concept (web forms, phone
  calls). The coordinator prompt says to call it after submitting a form for a task.
- **A deterministic backstop in `web-browser`.** When a task-bound turn types the principal's
  or Curia's email address or phone number into a page, the handler records a skeleton row:
  page domain, the identity typed as `given_contact`, the task title as `summary`. A later
  `record-outreach` call enriches it.

Rows close when their task closes (task status hook) or at `expires_at`.

### Matching an inbound message

For a non-principal inbound that the existing outbound-context path didn't match to a task,
in the dispatcher:

1. **Deterministic, free:** the sender's address is in `addresses` (`linkKind: 'address'`);
   or the sender's domain is in `domains`, excluding a freemail and shared-hosting list
   (`'org-domain'`); or the sender resolves to a contact in `contact_ids` (`'contact'`).
2. **Model check, only if step 1 missed and open rows exist:** a fast-tier call gets up to 10
   of the most recent open rows (summary, org, domains, given contact, created time) and the
   message (sender, display name, subject, first part of the body), and returns the matching
   row id or none (`'inferred'`). Signals include the service asked about, the principal's
   name, the time asked for, and the message arriving at `given_contact`.
3. An unauthenticated email sender (no `senderVerified`) caps the link at `'inferred'`.
4. Auto-generated mail is skipped.

**Strength (decision 7):** `address`, `contact` and authenticated `org-domain` are **strong**;
`inferred` is **weak**. `linkKind` and `strength` both go to the coordinator and the judge.

On a link:

- the turn's `agent.task` metadata carries `linkedTask { taskId, rootTaskId, outreachId,
  linkKind }`;
- the coordinator gets a block: "This looks like a reply to outreach for task <title>: <summary>
  (linked by <kind>)";
- the evidence collector reads `linkedTask` (above);
- the sender's address and contact id are appended to the row, so the next reply matches by
  address, **but only on a strong link, or after the principal answers "yes" to an ask on
  that thread**. Learning from a weak link would turn one model guess into a strong link
  for every later message *(builder's call)*;
- the reply is recorded where the task's wake reads replies, so the reply lane and the
  task-wake lane see the same thing. **The reply turn answers; the task gets a progress note
  only** and is not resumed or woken, so two lanes never both reply to the counterparty
  *(builder's call)*.

The link never changes the sender's tier. A weak link never unlocks an `inferred`
disclosure at any score; it only makes the requester askable.

## Asking the principal (failure 5)

Reuse the band hold path (`raiseSendApproval`):

- A `hold → ask` keeps the original send (with the data) as the held action. The approval's
  display text leads with the question, built from the rulings: "<Requester> wants your
  <label> to <task summary>. Share it?" followed by the draft.
- The send result tells the agent: held for the principal (#ref), deliver it now with
  `deliver-approval` on the urgent channel, and send the requester a short holding reply
  without the data. The holding reply has no detected items, so it passes.
- **Yes** (`approve-action`) replays the send with `humanApproved: true`, so it goes intact.
  **Yes and no** both write a row to a new `disclosure_decisions` table
  (`conversation_id`, `counterparty`, `label`, `decision`, `decided_by`, `action_ref`,
  `created_at`). A "yes" is an explicit principal directive for that label to that
  counterparty on that thread. A "no" stops further asks there for that label.
- A cold, unlinked stranger's request is `unsupported` and not askable: the draft bounces,
  the drafter declines politely, and a digest note is filed.
- Report items state facts correctly. Gateway-written items describe what was delivered
  (post-decision body). The coordinator's sender block states identity verification and
  message authentication as two separate facts, so a `verified` contact is never described as
  "unverified".

## Detection: Canadian SIN

Add `sin_ca` to `src/pii/scrubber.ts`: nine digits as `ddd-ddd-ddd` or `ddd ddd ddd`, or nine
bare digits only when "SIN" or "social insurance" appears nearby; Luhn checksum required;
first digit not 0 or 8. Unit tests cover false positives on numeric IDs, order numbers,
phone-like strings and UUIDs.

## Scenario harness (from #2192 Part 2) and scenarios

- **Per-case autonomy.** `FixtureAutonomyService` reads the current attempt's
  `autonomy: { score, gating }` from the case context, concurrency-safe. `OutboundGateway` and
  `ExecutionLayer` read gating lazily (from `autonomyService.getConfig().gating`) rather than
  at construction. The single-fixture restriction in `cli.ts` and the loader's
  `release_gate: false` rule for autonomy cases go away.
- **Sends through the gateway.** A send stub can opt in to running the real handler
  (`through_gateway: true`). The test gateway gets the real `PiiRedactor`, `BandSendReview`
  (real judge, real evidence collector) and an action-log repo, with fake transports
  (recording `sendMessage` clients) that never leave the process. The no-send guarantee is
  kept by construction: no real clients are ever wired.
- **Assertions** on what was delivered (body, cc), held (approval display), bounced or
  blocked, and on `task_outreach` / `disclosure_decisions` rows.
- **Cases** are the issue's nine scenarios, at scores 84 and 74 where behavior differs, in
  `tests/scenarios/cases`, joined to the release gate. Fictional names and placeholder numbers.
  Share fixtures with #2192's band cases where they overlap.

## Docs

- ADR-049 gains an addendum (or a new ADR if the builder judges it a separate decision): the
  judge rules on PII per item, authority comes from the directive, no cut-and-send at all (findings are rewritten).
- `docs/specs/14-autonomy-engine.md` and `docs/specs/15-outbound-safety.md` describe the new
  flow, outreach linking and the ask.
- A note on #2192 lists what applies under tier vs band and points to the harness.

## Delivery: a stack of PRs

1. Redaction reporting + `sin_ca` (both gating modes).
2. Judge fixes: grounding scope, report items as evidence, principal is never a disclosure,
   Curia's own addresses, removal of cut-and-send.
3. Detect → decide → act: split redactor, `disclosure` question, authority evidence,
   `TaskOriginator.authenticated`, the policy table, token bounce, copy principal, drafts.
4. Outreach linking: `task_outreach`, `record-outreach`, the browser backstop, matching,
   `linkedTask` evidence.
5. Asking the principal: ask display, `disclosure_decisions`, report accuracy.
6. Harness and scenarios, docs, #2192 note.

## Left to the builder

- Exact prompt wording for the `disclosure` question and the Authority block.
- The freemail / shared-hosting domain list and where it lives.
- The fast-tier model and call site for the link check (must follow the small-cap rules
  from #2310).
- Whether `principal.report` items from the turn are read by task event id or conversation.
- Test fixtures and unit test layout, following existing conventions.
