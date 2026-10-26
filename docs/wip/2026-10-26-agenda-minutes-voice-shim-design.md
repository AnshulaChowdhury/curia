# Agenda-and-minutes voice architecture

High-level design for driving a live voice call from a prepared agenda, capturing raw
minutes on the call, and handing those minutes to the async coordinator for structuring
and execution. Builds on the existing thin voice shim (`VoiceRuntime` / voice tool bridge)
and the `async-offramp` path rather than inventing a second spoken brain.

This is a design sketch, not an implementation spec.

## Core concept

A voice call under this architecture has three roles, deliberately split:

1. **Agenda builder (upstream)** — the main coordinator, a routine, or a person prepares
   what the call is about and resolves all source material into a self-contained payload.
2. **Voice shim (on the call)** — the thin voice-only coordinator is the sole voice the
   user hears. It accepts the agenda at call start, follows it conversationally, and
   produces **minutes** as its primary output. It does not structure work, provision
   routines, or grow a large tool set.
3. **Coordinator structuring pass (after the call)** — a stronger model, running async
   with the full tool set, turns those minutes into typed action items and executes them.

The shim stays lean on purpose: spoken turns are short, irreversible, and run under a
hard tool-round budget. Structure and side effects belong off the call.

## Agenda contract

An agenda is a small, explicit payload handed to the shim when the session starts. At
minimum:

- **Title** — what this conversation is for (spoken framing, not a UI chrome string).
- **Topics** — ordered list of what to cover; the shim walks these conversationally.
- **Optional prior-context pointer** — a handle into already-resolved material (see
  below), not a URL or path the shim is expected to fetch.

Who supplies it:

- A **routine** (e.g. daily onboarding check-in) that already knows the day’s focus.
- The **coordinator**, when it schedules or places a call after async work.
- A **person**, when the principal (or operator) starts a call with a stated purpose.

The contract is intentionally small. Anything richer belongs in the resolved source
blob, not in a growing agenda schema the spoken model must interpret mid-call.

## Source material: resolve upstream, not on the call

Attachments, web pages, OKF documents, and participant context must be **resolved into a
self-contained blob before the shim sees the agenda**. The shim has no fetch path —
references that are only pointers (paths, URLs, doc ids without content) are dead on the
call.

The agenda builder is therefore an async coordinator-shaped job (or an equivalent
upstream step): gather what the conversation needs, flatten it into text the spoken
model can use, and attach that blob to the session. Prefer enough context for a short
conversation over a perfect corpus. If material cannot be resolved in time, the agenda
should say what is missing rather than point at an unresolved source.

This keeps the spoken prompt cacheable and the tool list fixed. It also matches today’s
voice constraints: no documents bundle, no discovery, no mid-call skill activation.

## Shim role

On the call, the shim:

- Greets and frames from the agenda title and topics.
- Follows the agenda conversationally — one topic at a time, brief spoken turns.
- Stays the **sole voice to the user**; specialists and the full coordinator do not speak.
- May use the small existing voice tool set for light in-call needs (e.g. a quick
  `delegate` for calendar truth, or a simple `task-create` if something must be parked
  immediately), but the design goal is **not** to expand tool sprawl.
- Does **not** structure decisions into typed actions, edit OKF workspaces, create
  recurring schedules, or send on other channels as its main job.

Thinness is a feature. The shim is a simpler model with a lean prompt; asking it to
produce structured plans mid-call fights the voice budget and the product voice.

## Minutes

**Minutes** are the shim’s primary output: raw notes of what was said and decided on the
call. They are deliberately unstructured — prose (or lightly sectioned prose), not a
typed action schema.

The term is intentional:

- It covers an active conversational shim that walks an agenda.
- It also covers a future mode where the shim is mostly a **passive listener** (e.g. the
  principal talks through a topic while Curia takes notes), without renaming the
  artifact.

Minutes should be good enough for a stronger offline model to extract commitments. They
should not try to be that extraction. Incomplete topics, open questions, and “said they’d
think about it” belong in the notes as spoken reality, not forced into false structure.

## Async handoff

When the call ends (or a topic block is complete enough to ship), minutes ride an
**async-offramp-style** handoff to the coordinator — the same idea as today’s
`async-offramp` tool: enqueue durable work, return quickly, do not hold the spoken turn
for the full coordinator task.

The handoff payload should include at least:

- The agenda (title, topics, which were covered).
- The minutes blob.
- Session / conversation identifiers for provenance.
- Preferred follow-up channel if the principal should be reached when structuring is done
  (Signal or email), consistent with the existing off-ramp.

The live call is not waiting for structured results. The shim confirms that follow-up is
underway only when the enqueue actually succeeded.

## Coordinator structuring pass

Off the call, the main coordinator (stronger model, full pins, multi-turn tool use)
receives the minutes and:

1. Interprets them against the original agenda and any prior-context blob.
2. Produces **typed action items** — tasks, one-shot wakes, recurring schedules, document
   updates, config or preference changes, outbound follows-ups where appropriate.
3. **Executes** with the full tool set (`tasks`, `scheduler`, `documents`, sends, etc.).
4. Reports back to the principal on the agreed channel when something needs confirmation
   or when the batch is done.

Recurring cadence provisioning (daily → weekly routines, onboarding ramps, standing
jobs) happens here, not inside the spoken turn. That matches what voice deliberately
excludes today: the whole `scheduler` bundle, documents, and send skills.

## Voice tool findings (current baseline)

Relevant facts from the current shim, so this design does not assume tools voice does
not have:

- Voice’s fixed list (`VOICE_TOOL_NAMES`) is nine tools: `delegate`, `date-resolve`,
  `async-offramp`, `task-list`, `task-create`, `task-update`, `task-complete`,
  `memory-query`, `memory-store`.
- The four core **task** tools are present; the rest of the `tasks` bundle (`plan`,
  `checkpoint`) is not.
- The entire **`scheduler`** bundle is absent — no routine creation on the call.
- The **`documents`** bundle is absent; voice also does not load pinned SKILL.md
  playbooks the way `assembleAgent` / `appendSkillInstructions` do for text agents.
- Sends, discovery (`tool-registry` / `skill-activate`), and autonomy approvals are
  deliberately excluded; heavy or structured work is meant for `async-offramp` or
  `delegate`.
- Calendar truth on a call goes through `delegate` to `@calendar`, not through local
  calendar tools.

This design leans into that split: keep the shim’s list small; put structuring and
provisioning on the coordinator pass.

## Onboarding example

A concrete use of the architecture is a **ramped onboarding voice sequence**:

- A series of short agenda-driven conversations — preferences, identity, how they like
  to communicate, goals.
- **Cadence:** daily in week one, then weekly for about ninety days (exact schedule is a
  product choice; the point is a planned ramp, not an ad-hoc call spam).
- Early sessions mostly **capture** (minutes → preferences / profile / light tasks).
- Later sessions increasingly **provision**: the structuring pass creates or adjusts
  routines and schedules so the office keeps working between calls.

Each session still looks the same to the shim: agenda in, conversation, minutes out.
The ramp lives in how agendas are authored and what the coordinator is allowed to
execute afterward.

## Open questions

1. **Provisioning inside the session vs a separate step.** Should any routine or schedule
   creation happen before hangup (shim parks a note; coordinator starts immediately), or
   is provisioning always a distinct post-call job the principal can review? Bias in this
   sketch: separate step, with optional “start now” only when enqueue succeeded.
2. **Cross-session memory.** How much should later agendas assume? A capped set of OKF
   onboarding sections (resolved upstream into the source blob) is a candidate — enough
   continuity without dumping the whole workspace into the spoken prompt. Exact caps and
   ownership (who writes those sections on the structuring pass) are TBD.
3. **Text richness vs voice compression.** Structuring wants rich, reviewable artifacts;
   voice wants short, irreversible spoken turns. Minutes should stay compressible for
   speech-derived capture, while the coordinator pass is where richness and typing
   happen. Avoid pushing document-shaped output back onto the shim.
4. **Agenda authorship UX.** How much does a person edit vs a routine template vs the
   coordinator proposing the next call’s agenda after the last structuring pass?
5. **Passive-listener mode.** Same minutes artifact, different shim behavior — confirm
   whether one session type flag is enough or whether agendas need an explicit mode.
6. **Failure and partial coverage.** If the call drops mid-agenda, are partial minutes
   still handed off? Default yes — unstructured notes beat a lost session.

## Relationship to existing code

Anchors for a later implementation plan (not commitments in this doc):

- Voice prompt assembly: `src/channels/voice/voice-runtime.ts` (`buildVoiceSystemPrompt`)
- Voice tool list: `src/channels/voice/voice-tools.ts`
- Async handoff pattern: `skills/async-offramp/`, `src/agents/prompts/voice-async-offramp.ts`
- Pin / playbook injection the shim does not use: `src/startup/agent-assembly.ts`,
  `src/skills/pin-resolution.ts`
- Tasks vs scheduler split: `skills/tasks/`, `skills/scheduler/`, coordinator pins in
  `agents/coordinator.yaml`
)
