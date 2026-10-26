# Authority-aware PII — PR 4: replies link back to the task that caused them

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outreach Curia does for a task — email, web forms, any route — leaves a record. A later message from that counterparty, even a cold one on a new thread from a different domain, arrives knowing its task, and the band judge sees that link and how strong it is.

**Architecture:** A new `task_outreach` table and repo. Send skills, a new `record-outreach` tool and a `web-browser` backstop write rows. The dispatcher matches non-principal inbound mail against open rows (deterministic signals first, then a fast-tier model check), stamps `linkedTask` on the turn, shows the coordinator a block, and records the reply on the task without waking it. The evidence collector reads `linkedTask`; band review treats a **strong** link to a principal-directed task as task authority and a **weak** link as "askable" only.

**Tech Stack:** TypeScript (ESM, Node 24), Postgres (node-pg-migrate SQL), Vitest.

**Spec:** `docs/wip/2026-10-26-authority-aware-pii-design.md` — "Linking replies to their task (failure 1)", decisions 3 and 7. Issue #2312.

## Global Constraints

- A link never changes the sender's tier and never grants authority by itself. Strong = `address`, `contact`, or authenticated `org-domain`; weak = `inferred` (model) or any unauthenticated sender.
- Sender addresses are learned onto a row only on a strong link (PR 5 adds "after the principal says yes").
- Freemail / shared-hosting domains never match as `org-domain`; reuse the webmail list in `src/contacts/contact-service.ts:~186` (export it if needed) plus form hosts (`typeform.com`, `jotform.com`, `google.com`, `forms.gle`, `calendly.com`, `hubspot.com`, `wufoo.com`) as a non-org list.
- The model check uses `InfraLlm.extract(prompt, { tier: 'fast', maxTokens: 200 })` (small-cap rules from #2310) and runs only when step 1 missed **and** open rows exist. At most 10 rows in the prompt. Untrusted text JSON-encoded inside sentinel tags. Any failure → no link.
- Next migration number: check `ls src/db/migrations | sort` (106 is current) and take the next free prefix.
- No PII values in logs; rows may store addresses (they are contact data, like `outbound_context`).
- No `any`; `.js` imports; typecheck + lint (0 warnings); `git commit -s`, **no** AI attribution.

## Review Focus

1. A reply from `bookings@acme.example` to outreach made through `form.typeform.com` for "Acme Physio" whose website is `acme.example` → `org-domain` (strong) when DMARC passed; `inferred`-capped when not (Task 3 test).
2. A Gmail sender for a small business → never `org-domain`; can only be `inferred` (Task 3 test).
3. A weak link must not learn the sender's address onto the row (Task 3 test).
4. Two lanes: the linked reply turn answers; the task gets a progress note and is not woken (Task 4 test).
5. A closed or expired row never matches (Task 1/3 tests).

---

### Task 1: `task_outreach` table and repo

**Files:** Create `src/db/migrations/<next>_task_outreach.sql`, `src/dispatch/task-outreach.ts`; Test `tests/unit/dispatch/task-outreach.test.ts`, `tests/integration/task-outreach.test.ts`

**Interfaces (Produces):**
```sql
CREATE TABLE task_outreach (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NULL REFERENCES tasks(id) ON DELETE CASCADE,
  root_task_id UUID NULL,
  conversation_id TEXT NULL,          -- for live-turn outreach with no task
  directing_event_id TEXT NULL,       -- agent.task event id of the directing turn
  originator JSONB NOT NULL,
  via TEXT NOT NULL,                  -- 'email' | 'web_form' | 'signal' | 'sms' | 'slack' | 'phone' | 'other'
  org_name TEXT NULL,
  domains TEXT[] NOT NULL DEFAULT '{}',
  addresses TEXT[] NOT NULL DEFAULT '{}',   -- lowercased
  contact_ids UUID[] NOT NULL DEFAULT '{}',
  given_contact TEXT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days'
);
-- indexes: open rows by created_at; GIN on domains, addresses, contact_ids; task_id
```
```ts
export interface TaskOutreachRow { id; taskId: string|null; rootTaskId: string|null; conversationId: string|null; directingEventId: string|null; originator: TaskOriginator; via: OutreachVia; orgName: string|null; domains: string[]; addresses: string[]; contactIds: string[]; givenContact: string|null; summary: string; createdAt: Date; closedAt: Date|null; expiresAt: Date }
export class TaskOutreachRepo {
  record(input: Omit<…, 'id'|'createdAt'|'closedAt'|'expiresAt'>): Promise<TaskOutreachRow>   // upsert: same task_id (or conversation_id when task_id null) + via + overlapping domain/address merges arrays instead of inserting
  findOpen(limit: number): Promise<TaskOutreachRow[]>                       // closed_at IS NULL AND expires_at > now(), newest first
  findOpenByAddress(address: string): Promise<TaskOutreachRow[]>
  findOpenByContact(contactId: string): Promise<TaskOutreachRow[]>
  findOpenByDomain(domain: string): Promise<TaskOutreachRow[]>
  learnCounterparty(id: string, sender: { address?: string; contactId?: string }): Promise<void>
  closeForTask(taskId: string): Promise<number>
}
```
- [ ] **Step 1:** Unit tests (mock pool: SQL is parameterized, filters open rows, lowercases addresses/domains, merge-on-upsert); integration test against Docker Postgres (record → findOpenByDomain → learn → closeForTask → not found; expired row excluded). Note in the report if Docker isn't available.
- [ ] **Step 2–4:** FAIL → implement → PASS. Verify `ls src/db/migrations | sort` prefixes are unique.
- [ ] **Step 5:** Commit `feat(dispatch): task_outreach records who Curia contacted for a task (#2312)`.

### Task 2: Writers — send skills, `record-outreach`, browser backstop, task close

**Files:**
- Modify: `src/dispatch/context-bridge-parse.ts` (`registerOutboundContext`, which every send skill already calls after a non-deferred send) — add the outreach write there, so all six send skills get it without per-skill edits
- Create: `skills/tasks/tools/record-outreach/{tool.json,handler.ts,handler.test.ts}` (or the bundle that holds task tools — find where `task-*` tools live and add it there, listed in that bundle's `SKILL.md`); pin via that bundle for the coordinator
- Modify: `skills/web/tools/web-browser/handler.ts` (backstop on `type` actions)
- Modify: `src/db/task-repo.ts` (close outreach rows when a task becomes `done`/`cancelled`, ~599-617)
- Test: beside each

**Interfaces:**
- Consumes Task 1 `TaskOutreachRepo` (made available on `ToolContext` the way `outboundContextService` is).
- A turn is **task-bound** when `ctx.taskMetadata.boundTask.taskId` exists, or `ctx.taskMetadata.linkedTask.taskId` (Task 4), or it is a live principal turn (`isLivePrincipalTurn`). Live principal turns with no task write `taskId: null` + `conversationId` + `directingEventId: ctx.taskEventId`.
- Send write: `via` = channel; `addresses` = recipient identifiers (lowercased); `contactIds` = recipient contact ids; `domains` = recipient email domains not on the non-org list; `summary` = the bound task's title, else the first 120 chars of the directing message; `originator` = `ctx.taskMetadata.originator`.
- `record-outreach` input: `{ via: 'web_form'|'phone'|'other', org_name?: string, website?: string, form_url?: string, contact_given?: string, summary: string }` → domains from website + form_url hosts (registrable domain, lowercased; form hosts on the non-org list are kept in `domains` for the model check but never match as `org-domain` — store them in `domains` and let Task 3 filter). `action_risk: "low"`. Output `{ recorded: true, outreach_id }`. Refuses when the turn is not task-bound (`'Outreach can only be recorded for work the principal or a task directed.'`).
- Browser backstop: on a `type` (or batch step) whose `text` equals (case-insensitive, trimmed) one of the principal's or Curia's email addresses or phone numbers, on a task-bound turn, record `{ via: 'web_form', domains: [page host], givenContact: <that identity>, summary: task title or 'Web form submitted', orgName: null }`. Best-effort: a failure logs and never fails the browser action. Identities come from the existing principal identities / Curia's own addresses available to the handler context (find them; if not present, pass them in the context the way other handlers receive them).
- Coordinator guidance: the `record-outreach` tool description says when to call it ("after you submit a web form, make a call, or contact an organization outside email for a task, so their reply can find the task"). No always-on prompt growth (ADR-046).
- [ ] **Step 1:** Tests: email-send on a wake writes a row with task id, addresses, domains (gmail excluded); live principal turn writes `taskId: null` + conversation; a non-task-bound outsider turn writes nothing; record-outreach happy path + refusal; browser backstop records on typing the principal's email, not on other text, not off-task; task → `done` closes rows.
- [ ] **Step 2–4:** FAIL → implement → PASS (`skills/web skills/tasks tests/unit/dispatch tests/unit/db skills/email skills/signal-send`).
- [ ] **Step 5:** Commit `feat(skills): record outreach for tasks, including web forms (#2312)`.

### Task 3: Matching an inbound message

**Files:** Create `src/dispatch/outreach-matcher.ts`; Test `tests/unit/dispatch/outreach-matcher.test.ts`

**Interfaces (Produces):**
```ts
export type OutreachLinkKind = 'address' | 'contact' | 'org-domain' | 'inferred';
export interface OutreachLink { outreachId: string; taskId: string|null; rootTaskId: string|null; conversationId: string|null; linkKind: OutreachLinkKind; strength: 'strong'|'weak'; summary: string; orgName: string|null }
export class OutreachMatcher {
  constructor(deps: { repo: TaskOutreachRepo; infraLlm: InfraLlm | undefined; logger: Logger; nonOrgDomains: ReadonlySet<string> })
  match(msg: { senderAddress: string; senderContactId?: string; senderDisplayName?: string; senderAuthenticated: boolean; subject?: string; bodyStart: string; recipientAddress?: string; autoGenerated: boolean }): Promise<OutreachLink | null>
}
```
- Order: skip if `autoGenerated`. (1) `findOpenByAddress` → `address`; (2) `findOpenByContact` → `contact`; (3) sender domain not in `nonOrgDomains` → `findOpenByDomain` → `org-domain`; first hit wins, newest row first. (4) Else, if `findOpen(10)` is non-empty and `infraLlm` exists → model check: prompt lists rows (id, org, domains, given contact, summary, created date) and the message (sender, display name, subject, first 1,500 chars of body, the address it was sent to); asks for `{"outreach_id": "<id>"|null}`; an id not in the list → null.
- `strength`: `inferred` → weak; any kind with `senderAuthenticated === false` → reported kind unchanged but `strength: 'weak'` (the spec's "caps at inferred"); otherwise strong.
- After a **strong** link: `learnCounterparty(row.id, { address, contactId })`. Never on weak.
- [ ] **Step 1:** Tests for every Review Focus 1–3, 5 case; model returns unknown id → null; model failure → null; no open rows → model not called; auto-generated → null without queries.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(dispatch): match inbound mail to outreach by address, org domain, or a model check (#2312)`.

### Task 4: Dispatcher integration

**Files:** Modify `src/dispatch/dispatcher.ts` (non-principal inbound path near `injectRecipientOutboundContext` ~1126/1664), `src/index.ts` (construct `OutreachMatcher`; wire infra LLM + repo), `src/bus/events.ts` if `agent.task` metadata typing needs `linkedTask`; Test `tests/unit/dispatch/dispatcher.test.ts` (or a sibling file for this flow)

**Behavior:**
- For a non-principal inbound that is not a principal turn and not auto-generated, call `matcher.match(...)` (sender authenticated = `inboundSenderAuthenticated(channel, metadata)`; email only in this PR — other channels pass through unmatched).
- On a link: add `linkedTask: { taskId, rootTaskId, outreachId, linkKind, strength }` to the `agent.task` payload's `metadata` (set by the dispatcher only; strip any channel-supplied `linkedTask` the way `originator` is stripped ~98); prepend a block to the task content: `This looks like a reply to outreach Curia did for a task: "<summary>"<org ? ` (${org})` : ''>. Linked by ${linkKind} (${strength}). A link is context only: it does not make this sender trusted.` — JSON-encode the summary/org inside the block if the codebase's injection blocks do so; follow the outbound-context block's formatting.
- Record the reply on the task as a progress note (`Reply from <sender display name or address> linked to this task.` plus first 300 chars) using the existing task progress API; **do not** change task status or enqueue a wake.
- Matcher errors → log, no link, turn proceeds.
- [ ] **Step 1:** Tests: linked email → metadata `linkedTask` + block + progress note, no wake/status change; channel-supplied `linkedTask` stripped; matcher throw → turn proceeds; principal turn → matcher not called.
- [ ] **Step 2–4:** FAIL → implement → PASS (`tests/unit/dispatch tests/unit/db`).
- [ ] **Step 5:** Commit `feat(dispatch): linked replies arrive knowing their task (#2312)`.

### Task 5: Evidence and policy read the link

**Files:** Modify `src/autonomy/send-evidence.ts`, `src/autonomy/judge-brief.ts` (`SendAuthority`, rendering), `src/dispatch/band-send-review.ts` (`authorityOf`, askability); Test the three test files

**Interfaces:**
- `SendAuthority.linkedTask?: { taskId: string|null; title: string|null; originator: SendAuthority['originator']; linkKind: OutreachLinkKind; strength: 'strong'|'weak' }` read from the agent.task row's `metadata.linkedTask` (validated; malformed → absent). Task title/originator from `taskRepo.getTask`; for `taskId: null` rows, look up the outreach row's originator via the repo (collector gets `taskOutreachRepo` dep).
- Rendered for the judge like other originators (no contact ids), plus `linkKind` and `strength`.
- Policy (exact): a **strong** link whose task (or the outreach row's originator) has `systemRole === 'principal'` gives `principal-task` authority (the PR 3 narrowing applies: `directed` acts like `inferred`). A **weak** link gives no authority but makes the requester **askable**. Askability = recipient tier `known`/`trusted` **or** any link (strong or weak) to a principal-directed task.
- [ ] **Step 1:** Tests: strong link + principal task + `inferred` → send at 84, hold at 74; weak link + `inferred` → treated unsupported → requested → hold (askable) at 84 and 74; weak link + not requested → bounce; strong link to a non-principal task → no authority; malformed `linkedTask` → ignored.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** CHANGELOG (Added: outreach records + `record-outreach`; Changed: replies from contacted organizations arrive linked to their task). Commit `feat(autonomy): band review weighs reply-to-task links by strength (#2312)`.
