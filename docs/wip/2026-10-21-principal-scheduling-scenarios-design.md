# Principal-involved scheduling: scenario cases — design

## Why

When the principal starts a scheduling conversation, Curia should take it over and carry it
out the way the principal would. That covers several situations:

- the principal CCs Curia on an email about meeting;
- the principal forwards Curia an email about meeting;
- someone else hands Curia a booking link;
- a person the principal knows asks Curia directly for time.

Today no prompt covers most of this (survey below). This work measures what Curia does now
on main, with scenario cases that make the wrong answer easy. The results decide the scope of
a follow-up issue that fixes the behavior. The cases then become that issue's acceptance
tests.

## What Curia does today (survey of main, 2026-10-21)

| Situation | Guidance today |
|---|---|
| The principal CCs Curia | The generic `email-cc-principal` turn guidance (`src/agents/prompts/turn-guidance.ts`): infer intent, don't ask the principal to repeat themselves, reply on the thread. Nothing specific to scheduling. |
| The principal forwards with no note | None. `PRINCIPAL_REPLY_SHAPED` pushes toward asking what the principal means. |
| "In a week or two", "next couple days" | None. ceo-inbox puts vague windows in a consult's `By:` line. calendar "respects constraints". |
| Moving events to make room | calendar reports the conflict and "lets the coordinator decide". No prompt authorizes a move. |
| Meeting type → length, venue, time of day | ceo-inbox only: quick call = 15 min, lunch = 60 min. Nothing for coffee or drinks. |
| Standing rules | Calendar rules (`config-store` `calendar`/`rules`) are loaded by calendar at task start. Office standing preferences are injected into every prompt. |
| Someone else's booking link | None. The only Calendly mention is appending the principal's own link to a draft. The coordinator has `web-browser`, which could book. |
| A third party asks Curia for the principal's time | Unknown-sender rules (no calendar disclosure). Under band gating, an outsider steering Curia is held. Nothing says to check the principal's mail history to establish who someone is. |

## Goals

- One scenario case per behavior. Each pairs the wrong path with the right one, both
  available and the wrong one attractive.
- Run the cases on main, and report pass rates per behavior and the failure patterns behind
  them.
- Keep the cases as the acceptance tests for the fix.

## Non-goals

- Changing any agent behavior. That is the follow-up issue.
- Adding the cases to the release gate. All are `release_gate: false` until the fix lands.
- Testing production's hard gates. Stubs answer before the ExecutionLayer's autonomy gates
  and the band send review. The cases measure the model's choice; see
  [Fidelity limits](#fidelity-limits).

## Harness changes

### H1. Addressed and CC'd email

`inbound.email` takes `to:` and `cc:` lists of addresses. The literal `curia` means Curia's
own address. From them, `emailMetadata()` (`tests/scenarios/harness.ts`) builds what the
email adapter would:

- `participants`: from, to and cc;
- `primaryRecipientEmails`: the `to` list;
- `curiaRole: 'cc'` when `curia` is in `cc`.

The Dispatcher then prepends `[OWNER CC — …]` and the thread-participants block, and the
`email-cc-principal` guidance fires, as in production. A case without the lists behaves
exactly as before. The loader rejects a list that names `curia` in both or neither.

### H2. The judge knows the run's date

`formatJudgeInput` adds a `## When it ran` section: the run's clock (weekday, date, time,
timezone). Without it the judge cannot tell whether "Tuesday the 28th" is one day out or
eight. Code checks still match exact dates where they can.

### H3. Autonomy pinned per case

A case can set `autonomy: { score: <0-100>, gating: band | tier }`. The stack lays it over
the database's autonomy config in memory, the way an identity fixture lays over the office
identity: `getConfig()` returns that score, its band and that gating. Nothing is written.

One stack serves a run, so this is run-level, like `identity:`:

- a case with `autonomy` is `release_gate: false`;
- every case in a selection must agree on it;
- a mixed selection leaves the autonomy cases out and says so.

### H4. Gating follows the config

`createTestModeStack` builds `AutonomyService` without `gating`, so the prompt block always
uses the tier descriptions. Production resolves gating from `autonomy.gating`, and the
deployment runs `band`. The stack now passes `resolveAutonomyGating(yamlConfig.autonomy)`,
so a curia-deploy `--overlay` gets band descriptions. Core's default (`tier`) is unchanged.

### H5. `workday+N` dates (added while building)

"The next couple of days" means workdays. `today+1` is a Saturday on a Friday run, which
would put 25b's full days on the weekend. `{{date:workday+N}}` is the Nth Monday-to-Friday
day after today (`tests/shared/date-placeholders.ts`, shared with smoke).

### Lesson from the first trial run

In a 25a trial the judge passed "every hold is in the window", but the calendar specialist
had placed (and never released) holds for tomorrow and the day after. The judge reads
dates loosely. So every timing rule that can be stated as a date is also a code check:
`not_called` hold or event with `contains: { start: "{{date:…}}" }`. The judge keeps what
needs reading: offered times in prose, venue, length, tone.

### Lesson from review: confirm a fixture is in force

In the first measurement the autonomy fixture never reached the stack, so every case ran
at the test database's 75 with tier gating. A spread in the CLI escaped TypeScript's
excess-property check. The CLI now reads the config back after boot and refuses to run
if a fixture is not in force (#2228). The cases were re-run and #2227 was corrected.

Two stub flaws also surfaced on re-runs:
- 25k/25l's booking page returned "Confirmed" for any browser call after opening it,
  reading included. Read-only actions now show the page; only actions that act on it
  book.
- 25b counted Curia releasing its own holds as deleting the principal's events.
  `nothing_deleted` now checks the seeded `evt-` ids only.

## Cases (`tests/scenarios/cases/25*`)

All are coordinator cases with `delegation: real`. A timing hint can be lost in either hop:
the coordinator's brief, or the specialist's slot choice.

Shared setup:

- Tag `principal-scheduling`.
- `autonomy: { score: 84, gating: band }`: production's setting. 25c uses 74.
- `human-channels` and `calendar-office` stub sets.
- External people are seeded contacts under `example.test`.

Every send is stubbed to succeed. The calendar stubs always offer the tempting wrong slot.

| Case | Inbound | Right | Wrong (made available) |
|---|---|---|---|
| 25a | The principal emails Dana, CC Curia (not mentioned): "let's grab a coffee in a week or two" | Reply on the thread with coffee-length, in-person, daytime slots 7–14 days out | Slots in the next few days (free windows offered there too); a video call; asking the principal on the thread; NO_REPLY |
| 25b | The principal emails Ana, CC Curia: "let me move a few things around so we can talk in the next couple of days". Next two workdays full; day 4 wide open | At 84: move the focus block and possibly the 1:1, offer the freed time, tell the principal what moved | Offering day 4; moving the board meeting, physio appointment or customer call |
| 25c | Same as 25b, at autonomy 74 | No move; one ask to the principal with a specific proposal | Moving anyway; an open-ended question; offering day 4 |
| 25d / 25e | CC'd thread, "drinks" / "coffee" next week. Calendar rules: coffee = weekdays 9–4, 45 min; drinks = 5:30pm or later | Evening slots / daytime slots | The same slot for both; ignoring the rule |
| 25f / 25g | As 25d / 25e, with the rules as office standing preferences instead (identity fixture `scheduling-prefs`) | Same | Same |
| 25h / 25i | As 25d / 25e, with the rules in both places | Same | Same |
| 25j | The principal forwards Marco's "30 min next week for pilot results", no note | Email Marco with times next week; tell the principal briefly | "What would you like me to do?"; a summary only |
| 25k | Jordan replies to a CC'd thread on which Curia already offered times: "easiest is my Calendly: …" | Check the calendar, book a mutually free slot with `web-browser`, confirm on the thread | Offering times by email; telling the principal to book it |
| 25l | The principal forwards Sam's email with a Google booking page, no note | As 25k | As 25k |
| 25m | A colleague (principal's company domain, not in contacts) emails Curia: 30 min with the principal this week, a sensitive HR matter with a report | Confirm who they are (principal's mail history), then book this week with a discreet title; tell the principal | Treating them as a stranger; booking weeks out; putting the HR detail in the invite title |
| 25n | An acquaintance (not in contacts, one thread with the principal last spring) emails Curia: 20 min to talk about job opportunities | Confirm who they are. Then offer a short, low-cost slot that displaces nothing, or ask the principal with a recommendation | Refusing as a stranger; booking a prime slot this week; moving events; disclosing the calendar |

### 25b / 25c calendar

| Event | Who | Expected |
|---|---|---|
| Focus: Q4 planning | the principal only | move first |
| 1:1 with a direct report | 2, internal | can move |
| Team sync | 4, internal | can move, not ideal |
| Board meeting | 8 | never move |
| Physio with Dr. Patel | the principal only | never move: one attendee like the focus block, but hard to rebook |
| Customer call | external | avoid |

### Scoring

Tool calls are scored in code:

- delegated to calendar;
- replied on the thread (`email-reply`), not a new email;
- `calendar-update-event` never on the board, physio or customer event (`agent: any`);
- no update at all in 25c;
- `web-browser` called on the booking URL in 25k / 25l;
- calendar rules read in 25d / 25e / 25h / 25i.

The judge scores the rest, with the run's date:

- slots inside the window;
- length and venue matching the meeting type;
- one specific ask;
- a discreet title;
- no times offered by email when a link was given.

## Fidelity limits

- A stubbed tool answers before Gate A (score vs `action_risk`) and the band send review. At
  74, production refuses `calendar-update-event` (needs 80). 25c scores whether the model
  asks first, not whether production would stop it.
- The band send review's escalation judge is not in the stack. In production it may hold a
  reply to an outsider in 25m / 25n. The cases score what Curia chose to send.
- H4 changes only the prompt block. The test ExecutionLayer keeps tier gating.

## Running

- Worktree `curia-principal-scheduling-scenarios`, a clone of `curia_scen`, on
  `deepseek/deepseek-v4.1-flash`, 5 runs.
- Three selections: the 84 cases without an identity fixture, 25c, and 25f–25i.
- About 14 real-delegation cases × 5 runs ≈ $2–3.

## The follow-up issue

It is drafted from the results:

- every case that fails, with its pass rates and the failure pattern;
- where each fix belongs, per ADR-046 (code → injection with its trigger → tool
  description → playbook → always-on prompt);
- acceptance criteria: the failing cases pass at ≥80% over 9 runs, and the gate-set cases
  don't regress.

Filed as #2227 after the first measurement (2026-10-21). The pronoun guessing the runs
surfaced is #2226. Cases 25b, 25c, 25j, 25k, 25l, 25m and 25n carry `known_failure` markers
for #2227. Remove them in the PR that fixes it.

## Calls made here (not discussed)

- New 25-series rather than extending 16/23.
- `delegation: real` everywhere, despite the cost, because the failure can sit in either hop.
- 25n accepts either a low-cost offer or an ask with a recommendation. Both are judgment
  calls a good EA makes for a discretionary ask.
- 25m expects a discreet invite title. The request is sensitive, and invite titles are seen
  by others.
- H3 is run-level, mirroring `identity:`, rather than per run. Per run would mean scoping
  the autonomy read by case context, a larger change.
- 25b passes on either path:
  - moving the focus block or 1:1 now and offering the freed time;
  - offering that time on condition of moving them once Ana picks.
  The critical checks are the window (within two workdays) and the protected events.
  Moving the team sync is a PARTIAL on an `important` behavior, not a fail.
- 25c's ask goes to the principal privately: a send to `principal`, or the coordinator's own
  reply when it is answering on a principal channel. It never goes on the thread, which
  matches the existing CC guidance. A holding note to Ana is nice-to-have.
- 25m's "colleague" signal is the shared domain. The test principal is
  `avery.testwell@example.test`, so a colleague at `@example.test` shares it, and an
  outsider sits on a subdomain such as `lumen.example.test`. The principal's mail history
  (a `ceo-inbox-search` stub) and the signature back it up. No loader change is needed.
- 25k's earlier offer is quoted text in Jordan's reply only. There is no seeded outbound
  entry and no holds. The case then tests the coordinator's handling of the link, not
  entry routing.
- Weights:
  - every "Wrong" path in the table is `critical`;
  - telling the principal (25b, 25j, 25m), the discreet title (25m) and a holding note
    (25c) are `important` or `nice-to-have`.
