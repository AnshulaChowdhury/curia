# Onboarding journey: from install to first real work — design

**Status:** Draft, 2026-10-29
**Scope:** product positioning, docs, setup tooling, and the agent-led onboarding program
**Related:**
- ADR-055 (PWA, #2341)
- spec 18 (onboarding)
- `docs/wip/2026-10-26-agenda-minutes-voice-shim-design.md` (agenda/minutes architecture; first
  slice #2322)
- #2338 (`pinned_context`)
- `docs/wip/2026-10-30-onboarding-hawd-model.md`: the same journey modelled from the principal's
  side in HAWD notation. Several changes below came from it.

## Why

Curia is built for an executive, and much of its value comes from working across channels: it
can email people, message the principal, and hold a real conversation by voice. Today's setup
story hides all of that:

- Every surface says the only requirement is Docker plus an Anthropic key.
- Every channel is optional.
- The setup-wizard agent opens with "instant wins first — no credentials needed".

The result is an install that "works" but never shows the product: a chat box in a console with
no inbox, no phone presence and no voice.

The end state: once Curia is installed, the principal has an assistant they can email, message
and talk to. Its first job is to learn how they work, through a short series of voice calls run
from an agenda. Within a week or so it is doing real work (email and scheduling) against
priorities the principal has confirmed.

## Goals

1. **Reposition setup around three channels.** Curia needs its own email account, a messaging
   route to the principal (the PWA by default), and voice. The docs, README, website and
   installers say so plainly and up front.
2. **Make onboarding a conversation, not a form.** After setup, Curia runs the rest of
   onboarding itself: a first voice call driven by an agenda, then a planned series of
   follow-up calls.
3. **Reach the "aha" moment.** Curia infers the principal's current priorities and standing
   inbox and calendar rules from their email and calendar history, confirms them with the
   principal, and works against them from then on.
4. **Fix the setup-doc inconsistencies** found during research (Appendix A) as part of the
   repositioning.

## Non-goals

- **Google Meet or Curia-initiated calls.** Curia joining a booked call (#2231) is nice-to-have.
  This journey uses the existing pattern: the agenda is parked, Curia nudges, and the principal
  calls in.
- **In-app OAuth for the principal's mailbox.** It stays a manual Nylas grant, explained on a
  call and in a guide.
- **Requiring Signal or SMS.** They remain alternative messaging routes. Requiring a phone number
  is exactly the barrier the PWA exists to remove (ADR-055).
- **Agenda-driven sessions over text chat.** Texting with Curia is mostly ad-hoc and async, and
  stepping through an agenda that way may feel wrong. This is tested separately as a spike (issue
  10). Nothing in this milestone depends on it.
- **Priorities in specialist agents.** ceo-inbox and calendar do not pin the priorities document
  in this milestone (see *Priorities: scope*).
- **An operator role.** A design issue only (issue 11). Nothing in this milestone depends on it.

## Anti-goals (failure even if it technically works)

- **A requirements list that reads like a wall.** If the docs leave an executive thinking "I
  need six API keys before I can try this", we've failed, even if every key is correct.
- **Ad-hoc call spam.** Every follow-up call is one the principal agreed to at the end of the
  previous call. Curia doesn't improvise a meeting every time it has a question.
- **Acting on inferred priorities or rules before the principal confirms them.** They stay a
  draft until then.
- **Visible changes the principal didn't expect.** Mail labelled and leaving the inbox, holds or
  moves on the calendar, and drafts sitting unsent all read as broken, not helpful, to someone
  who wasn't told they were coming.
- **Context sprawl.** Priorities are pinned where they clearly pay off (the coordinator, voice),
  not everywhere they might help.
- **A dead end without voice.** Someone who skips voice still has a working assistant and keeps
  getting a reason to set voice up.

## The journey

### Phase 0 — Install (the operator, ~5 min)

What's needed: Docker with Compose, an LLM key, and **a domain or HTTPS route** to the host.

HTTPS is new as a stated requirement. The PWA installs only on a trusted HTTPS origin (ADR-055
§1, and its "HTTPS is required for the app" consequence), so the plain-`localhost` install
topology can't support the default messaging route. The installer already asks the topology
question (local, domain or proxy). The local option stays, but it is labelled a dev or try-out
path that needs Signal or SMS to run onboarding.

### Phase 1 — Give Curia a desk (the operator, ~30–60 min, can span days)

| Need | Default route | Alternatives | What the operator gets |
|---|---|---|---|
| **Its own email** | Nylas grant for a dedicated mailbox | — | Nylas API key + grant |
| **A way to message the principal** | PWA, installed on the principal's phone by QR pairing | Signal, SMS (Telnyx) | nothing beyond HTTPS for the PWA |
| **A voice** | LiveKit (bundled) + Deepgram (speech-to-text) + Cartesia (text-to-speech) | — | Deepgram key, Cartesia key + voice id |

Each row in the docs carries an honest time and cost estimate. Verify current vendor pricing at
write time; don't copy numbers from memory.

### Phase 2 — Kickoff (Curia)

**Trigger:** a messaging channel to the principal is working. Curia's own email is not required
to start; it is part of the desk, not the kickoff.

- **Voice is working:** Curia parks the first onboarding agenda and messages the principal, for
  example "I'm set up — when you have 15 minutes, tap here to call me." The principal calls in
  from the PWA, console or Signal, and the parked agenda loads at session start (issue 5).
- **Voice isn't working yet:**
  - Curia works normally for ad-hoc chat.
  - It sends the principal a message explaining that onboarding happens in a few short voice
    conversations, and asks for voice to be set up.
  - It keeps nudging, politely and with a cap on frequency, until voice works. Then it proceeds
    as above.
  - Setup status shows voice as incomplete and never auto-defers it.
  - Inbox triage stays off: the "what to expect" topic is delivered only on a voice call, and
    the switch turns on after it. The principal can still ask for triage by message, which is a
    directed change.
  - Running sessions over text instead depends on the outcome of the spike (issue 10). Until
    then, onboarding is voice only.

### Phase 3 — First onboarding call (Curia + principal, voice, agenda-driven)

**The onboarding plan.** At kickoff Curia seeds one onboarding plan document for the principal
under `/meetings/`, copied from a fixture that ships in the repo. It keeps two things apart:

- **What to cover:** the sessions and the topics each one should reach.
- **What's happened:** topics covered and left, and what the principal has said about timing and
  interests.

The principal may edit the plan at any time. Curia records in *what's happened* which topics a
call covered, read from the minutes. It changes *what to cover* (topics, timing) only with what
the principal agreed on a call (a directed change), never on its own judgment.

Onboarding starts only on a fresh install: one with no onboarding plan yet, reaching kickoff
for the first time. Installs that already have a working principal are not pulled into it; the
principal can start it on request. Each session's agenda is generated from
the plan shortly before the call. The fixture's topic list is the onboarding playbook, so improving
it improves onboarding for every principal who starts after.

The first agenda covers:

1. **Who the principal is and how they like to work.** Identity, preferences, tone and
   autonomy, mostly what the text setup-wizard agent covers today. It is reframed as a
   conversation and written out by the minutes and structuring pass.
2. **What to expect from Curia.** Built from Curia's current settings when the agenda is
   generated, so it never promises behaviour Curia won't show:
   - **Inbox:** Curia labels mail and archives some of it, so mail will leave the inbox on
     purpose. It says where that mail goes.
   - **Calendar:** Curia may place tentative holds to protect time; those go ahead without
     asking (`calendar-create-hold` is risk 70). Creating or moving real meetings asks first at
     the starting autonomy score (risk 80).
   - **Drafts:** Curia sometimes drafts replies and leaves them unsent. It asks how the principal
     wants to hear about them, for example: "Do you think you'll see those, or would you rather I
     send you an end-of-day reminder if there are drafts left unsent?" If the principal wants the
     reminder, the structuring pass sets up the routine.
   - **Check-ins:** in plain words, "For now I'll check with you before booking or moving
     meetings. As you approve things, I'll ask less." This is the autonomy score (starting at 75,
     approval-required), explained.

   Once the principal has heard this, inbox triage is switched on (see *Phase 4*).
3. **Connecting the principal's email and calendar.**
   - Curia explains why it wants delegated access to the principal's own email and calendar,
     separate from Curia's own inbox, and what it will do with it.
   - Afterwards it sends the how-to guide to **the principal**, with: "If someone set Curia up
     for you, forward this to them."
   - The guide says a restart is needed, because the principal's mailbox and calendar bind at
     boot. "Connected" is therefore detected at boot; there is no hot-reload.
4. **Agreeing the next session.** When, and roughly what it should cover. The principal can also
   say how often they'd like to meet over the first couple of weeks; that goes in the plan as a
   preference, not a fixed series.

**Scheduling after the call.** Nothing is scheduled *during* the call, because voice has no
scheduler bundle by design (agenda-minutes design, "Voice tool findings"). The post-call
structuring pass (the `meeting-minutes-structuring` skill) books **only the next session** and
records what was covered in the plan. The principal explicitly agreed it, so it is a directed
change and gets executed, not proposed. Sessions are booked one at a time because each
principal's interests, timing and availability shift as onboarding goes on.

"Booking" means a scheduler job at the agreed time that generates the agenda, parks it and sends
the nudge. It is not a calendar event: after the first call the principal's calendar usually
isn't connected yet, and an event would need approval at the starting autonomy score. The
skill's in-bounds list grows to cover that one job and writes to the onboarding plan. An
onboarding agenda stays loadable until its session happens, so a principal who calls in late
still gets it rather than a free-form call (today's ±12h `isDue` window would drop it).

**Each later session.**
- A scheduled job generates that session's agenda from the onboarding plan and what Curia has
  learned so far.
- It parks the agenda and sends a nudge.
- The principal calls in.
- At the end, the principal and Curia agree the next session, and the structuring pass books it.

### Phase 4 — Priorities, then real work

1. **Trigger.** When the principal's email and calendar grant is first detected as connected (at
   boot), a one-time background job runs.
2. **Analysis.** It reads a window of calendar and sent-mail history (about 90 days by default)
   once, and writes three drafts. Every item comes with the evidence behind it.
   - **Draft priorities:** recurring meetings, frequent correspondents, and threads with high
     effort or high stakes.
   - **Draft inbox rules:** how the principal handles mail, such as senders they always answer
     quickly, mail they never open, or threads they hand off.
   - **Draft calendar rules:** how they schedule, such as times they keep clear, meeting lengths,
     buffers, and which meetings they decline or move.

   Editing a draft is easier than filling in a blank page, and a draft drawn from the principal's
   own history is the clearest sign that Curia "gets" them.
   - **Model:** the strongest configured tier. This is a one-time, high-stakes read, and quality
     beats cost.
   - **Cost:** there is no cap. The job estimates its cost before starting, logs the actual
     spend, and records the measured cost from the first real run in the issue.
3. **Confirmation.**
   - **Priorities:** the next onboarding session's agenda is built around the draft. The
     principal confirms, corrects or drops each priority, and the confirmed list becomes the
     priorities of record.
   - **Rules:**
     - **On the same call:** Curia raises a few of the strongest rules out loud ("I noticed you
       never take meetings before 9. Should I protect that?").
     - **By email afterwards:** it sends the full draft as a short numbered list, and the
       principal replies in plain words ("drop 3, make 5 Fridays only").
     - **Receipt:** Curia applies the edits to `/shared/inbox/rules.md` and
       `/shared/calendar/rules.md`, then replies with the rules as written and a console link to
       each ("Here's what I've set. You can change these anytime here."). The receipt doesn't
       wait for an answer.
     - **Existing rules:** rules the principal already has are kept. Conflicts are flagged in
       the email. Nothing is written until the principal replies.
4. **Baseline settings.** In the same session, Curia proposes baseline settings for the work it
   already does:
   - inbox triage preferences
   - calendar rules and preferences
   - the daily activity recap and its time

   It also asks whether the principal wants other routines, such as meeting debriefs or a weekly
   look-ahead. Whatever the principal agrees on the call is a directed change, and the
   structuring pass executes it.

5. **Triage switch.** Scheduled inbox triage labels and archives mail, which is the most
   surprising thing Curia does to a new principal. ceo-inbox gets a `ceo_inbox/triage` config
   (`{"enabled": …}`), alongside the existing `ceo_inbox/decision_tagging`. Kickoff writes it
   **off** explicitly on a fresh install. A missing value means on, so existing installs (prod
   included) keep triaging when this ships. It is switched on once the principal has heard the "what to expect" topic on the
   first call, as a directed change. The principal can switch it off or on again by voice or
   message. The switch belongs to the agent's own config, so ceo-inbox stays independently
   configurable; the hourly wakes while it is off are cheap and limited to the first few days.

   Calendar needs no switch. Creating or moving meetings is approval-required at the starting
   score (risk 80), and tentative holds (risk 70) are named in the "what to expect" topic. Triage is not held back until
   priorities are confirmed. Once switched on it runs as it does today, and onboarding tunes it.

**Onboarding is "done" when** the principal has confirmed their priorities and agreed at least
one recurring routine. The remaining sessions shift from *capturing* to *tuning*: reviewing how
the routines are going and adjusting them.

"Done" marks the end of capture, not reliance. Reliance builds over the following couple of
weeks: the principal approves or corrects what Curia does, the autonomy score rises, and the
check-ins fade. The HAWD model's A5 describes this loop.

### Priorities: scope

- **Where they live:** one document, `/shared/principal/priorities.md`. It has no hard size
  limit; #2338's size warning is the safeguard. The principal can edit it in the console.
- **Who uses it:**
  - **The coordinator:** declared in its `pinned_context` (#2338).
  - **Voice:** the voice runtime builds its own prompt, so #2338 doesn't reach it. The document
    is read once at session start and added to the voice prompt, not on every turn, to protect
    response time (issue 9).
  - **The daily recap:** frames the day against the priorities.
- **Not in this milestone:** ceo-inbox and calendar don't pin it. Pinning it into a specialist
  agent that runs on a schedule costs tokens on every run, and nobody has measured whether it
  improves triage. If we want it, it's a later experiment with a before-and-after comparison.

## How we describe the requirements

**Show the full list up front, but don't call the channels "prerequisites".** Present two layers,
and frame the second as *what a new assistant needs*, which any executive recognises from hiring
a person:

> **To install Curia** (~5 minutes): Docker, an LLM API key, and a domain (or another HTTPS
> route) for the server.
>
> **To give Curia a desk** (~30–60 minutes, at your pace): an email address of its own, a way to
> message you (the Curia app on your phone), and a voice. Then Curia takes it from there and
> books your first conversation.

Why this framing:

- **"Prerequisites" for everything** makes the channels feel like a barrier you must clear before
  you see anything.
- **Hiding them until after install** feels like a bait-and-switch when voice turns out to need
  two more vendors.
- **The two-layer framing is honest about the full list.** It explains *why* each item exists,
  and separates the 5-minute part from the part done at the operator's own pace.

The README, the curia-docs index and installation pages, and the website hero all use the same
two-layer wording. The installation page's "Full setup — optional capabilities" section splits
into **"Give Curia a desk"** (email, messaging, voice) and **"Optional capabilities"**
(embeddings, Tavily, Slack, and Signal or SMS as alternatives).

## Decisions

| Topic | Decision | Whose call |
|---|---|---|
| Default messaging route | PWA (#2341); Signal and SMS are alternatives | Joseph |
| First call mechanics | Agenda parked + nudge + principal calls in; Meet out of scope | Joseph |
| Principal email & calendar | Guide sent to the principal ("forward if someone set Curia up for you") + agenda item; manual Nylas grant; no OAuth | Joseph |
| Voice requirement | Required for onboarding sessions; Curia stays usable without it and keeps nudging | Joseph |
| Text-chat sessions | Not committed; spike first (issue 10) | Joseph |
| Priorities analysis model | Strongest tier; no cost cap; estimate + logged spend | Joseph |
| Priorities scope | Coordinator + voice + recap; no specialist pinning; no hard size cap | Joseph |
| Operator role | Design issue + ADR, off the critical path (issue 11) | Joseph |
| Inbox triage frequency | Hourly (from every 15 min), 6am–11pm (issue 12) | Joseph |
| Kickoff trigger | Messaging working; Curia's email not required to start | Joseph (agreed proposal) |
| Baseline settings | Proposed on the priorities call; agreed = directed change | builder's call |
| Triage switch | `ceo_inbox/triage` agent config, off on a fresh install, on after the "what to expect" topic; agent-owned, not a scheduler gate. Without voice it stays off unless the principal asks; no text version of the topic until the spike (issue 10) says otherwise | Joseph |
| Standing rules | Inferred with priorities in one read (#2362); a few raised on the call, the full list emailed for plain-word edits, then a receipt with console links | Joseph |
| Check-ins while trust builds | The existing autonomy score, explained in plain words on the first call; no new confirm-before-acting rule | Joseph |
| Drafts | First call asks how the principal wants to hear about unsent drafts; an end-of-day reminder routine if wanted | Joseph |
| HTTPS as an install requirement | Stated up front; local topology labelled try-out only | builder's call (follows from ADR-055) |
| Voice in the installer | Voice compose profile on by default; skippable Deepgram/Cartesia prompts | builder's call |
| "Connected" detection | At boot; guide tells the user to restart | builder's call |
| Session scheduling | One session at a time: the structuring pass books the next one agreed at the end of each call; nothing created up front | Joseph |
| Agenda authorship | One editable onboarding plan per principal under `/meetings/`, seeded from a repo fixture at kickoff, holding topics and progress separately; each session's agenda generated from it shortly before (resolves agenda-minutes open questions 5 and 6 for onboarding) | Joseph |
| Voice priorities loading | Once per session at start, not every turn | builder's call |
| Setup-wizard agent | Its content becomes the first-call agenda; channel-credential handoff to the console stays | builder's call |

## Work breakdown (proposed issues, one milestone)

Tracked in milestone **v0.48 - Onboarding Journey** (#29). #2341 (PWA) moved in from v0.45 because it is on the
critical path.

| # (GitHub) | Issue | Depends on | Size |
|---|---|---|---|
| 1 (#2356) | **Reposition setup docs around two-layer requirements.** README, curia-docs (index, introduction, installation, deployment, configuration), website hero, `docs/dev/setup.md`, spec 18. Also fixes the Appendix A inconsistencies. | — (can ship first; describes the PWA as coming) | L |
| 2 (#2357) | **Installer: HTTPS-first topology, voice on by default.** `install.sh`, `scripts/setup.sh`, compose. Recommend the domain or proxy topology, enable the voice profile, offer skippable Deepgram/Cartesia prompts, and end with a pointer to the desk checklist. | — | L |
| 3 (#2341) | **PWA** (existing #2341) | — | XXL |
| 4 (#2358) | **Setup status: onboarding readiness.** The catalog marks email, messaging (web, Signal or SMS) and voice as the desk. Adds a `principal_mailbox` entry (`ceo_nylas_grant_id`). `setup-status` reports *kickoff ready* (messaging) and *sessions ready* (voice). The console checklist shows both. Voice is never auto-deferred. | — | M |
| 5 (#2359) | **Console and PWA calls load the parked agenda.** Only Signal calls run `prepareSessionAgendas` today. | — | S |
| 6 (#2360) | **Onboarding program.** Onboarding plan fixture, seeded per principal at kickoff; first-call agenda, which replaces most of the text setup-wizard flow and includes the "what to expect" topic and the drafts question; the `ceo_inbox/triage` switch, off until that topic; kickoff and voice nudges driven by issue 4; post-call structuring books the next session; per-session agenda generation and nudge. | 3 (or Signal/SMS), 4, 5 | XL |
| 7 (#2361) | **Principal mailbox guide and "connected" trigger.** A curia-docs guide for creating the principal's Nylas grant (addressed to the principal, with the forwarding line); detect the first connection at boot and emit the trigger for issue 8. | 4 | M |
| 8 (#2362) | **Priorities and standing-rules inference and confirmation.** One-time job over about 90 days of calendar and sent mail on the strongest tier, with a cost estimate and logged spend. One read produces draft priorities, inbox rules and calendar rules, each with evidence. Priorities are confirmed on the next call and written to `/shared/principal/priorities.md`; rules are confirmed by email and written to the existing rules documents, with a receipt. Pinned to the coordinator; used in the daily recap. Needs an ADR for where priorities live and their sensitivity. | 6, 7, #2338 | XL |
| 9 (#2363) | **Voice loads priorities at session start.** Read `/shared/principal/priorities.md` once per call into the voice prompt. | 8 | S |
| 10 (#2364) | **Spike: agenda-driven onboarding session over text chat.** Run a parked agenda as a chat session in the PWA or console. Judge whether it feels right compared with ad-hoc async texting. Report a go or no-go for making it the no-voice path. | 5 | M |
| 11 (#2365) | **Design: an operator role.** ADR for recording who set Curia up, as a role on a contact (default: the principal). Technical asks (credentials, restarts, health alerts) route to the operator, and the role carries no principal authority. | — | S (design only) |
| 12 (#2366) | **Inbox triage hourly.** Already on main: #1915 moved the cron to `0 6-23 * * *`. Nothing left to build; the issue can close. | — | — |

**Critical path:** 3 → 6 → 8. Issues 1, 2, 4, 5, 7, 10, 11 and 12 can run in parallel.

## Left to the builder

- **Agenda wording** for each session type, and the topics in the onboarding plan fixture.
- **Evidence heuristics are not left to the builder.** Which signals count for priorities and
  rules, and how they're weighted, is a written deliverable of #2362, reviewed with the rest of
  it. It governs the step that most decides whether Curia "gets" the principal.
- **Voice nudges:** copy and frequency cap, within the "planned, not spammy" anti-goal.
- **Format of the priorities document:** described in its own frontmatter, per #2338's
  convention.

## Appendix A — setup-doc inconsistencies to fix in issue 1

1. **LLM providers.**
   - `curia-docs/core-concepts/introduction.mdx:108` lists Ollama, which has no provider in the
     code.
   - Bedrock appears only in the dev docs.
   - The installers hard-require an `sk-ant-` key, while `seed-vault.ts:58` says no provider is
     mandatory.
2. **Website prerequisites.** The hero (`curia-website/src/pages/HomePage.jsx:239-254`) lists the
   source-install prerequisites (node, pnpm), which the image install doesn't need.
3. **API key missing.** The installation page's Prerequisites list (`installation.mdx:12-17`)
   omits the API key that a later step asks for.
4. **Embeddings described as optional.** `docs/dev/setup.md:255` says the setup wizard is off
   without embeddings. Verify this and state it.
5. **Email vault key names** differ across `how-channels-work.mdx`, `installation.mdx`,
   `email-setup.mdx`, `.env.example` and `docs/dev/setup.md`.
6. **Email activation.** `installation.mdx:147` says email "activates automatically", but
   `docs/dev/setup.md:249` says it must be enabled in the console's channel registry.
7. **Signal socket path.** The catalog asks for `channel.signal.socket_path`; the docs say not to
   set it. `signal-setup.mdx:122` also links to the wrong step.
8. **Stale specs.** Spec 18 (`:44-45`) and `docs/dev/setup.md:104` describe channel variables in
   `.env`. Spec 08 (`:53-91`) describes a `curia setup` CLI that doesn't exist.
9. **Channel lists.** The README (`:43`), `introduction.mdx` and `index.mdx` name only email and
   Signal.
10. **Email transport.** `introduction.mdx:95` says "IMAP polling + SMTP via Nylas"; it is the
    Nylas API.
11. **Time claims.** `index.mdx:10` says "under 15 minutes" and `installation.mdx:6` says "about
    five minutes". Neither survives the new framing; use the two-layer estimates.
