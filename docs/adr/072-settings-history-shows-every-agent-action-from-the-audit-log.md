# ADR-072: Settings → History shows every agent action, read from the audit log

Date: 2026-11-28
Status: Accepted

## Context

The owner wants to review every action by every agent, with inputs and outputs. The audit log already holds messages,
tasks, tool calls and AI calls (full text in the AI call archive), but no screen showed them, and two things were not
recorded: tools run outside an agent's turn, and the AI call that summarises long chats.

## Decision

- **Read the audit log**; no second copy. Conversations list, steps and one step's full detail, through owner-session
  routes (`/api/history`). Read only. Phone tokens do not open them.
- A conversation includes the specialist conversations it delegated to, indented.
- **A `tool.recorded` event** for tools run outside a turn (approved actions run again, memory extraction, follow-up
  tasks), asked for per call with `record`. Nothing subscribes to it: reusing `tool.result` would have changed reply
  locks and send evidence. A test fails if a new caller does not ask.
- The summary call goes through the telemetry provider, filed under its conversation.
- Everything shown passes the secret redactor (ADR-070), so older rows are masked.
- A record that is missing or cut off says so.

## Consequences

- One screen now gathers private content: messages, email text, figures. It is behind the console sign-in only.
- AI calls made during voice calls are filed under "Background AI calls", not the call.
- What was not recorded before this, or has been purged, stays missing.
- The list reads every audit row in the chosen dates; long ranges will get slower as the log grows.
