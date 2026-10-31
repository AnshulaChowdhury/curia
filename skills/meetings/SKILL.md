---
name: meetings
description: >
  Park an agenda for an upcoming principal call. The call loads it; this bundle does not join the call.
version: "0.1.0"
tools:
  - meeting-agenda-park
---

An agenda is for a principal call. Park one when the principal, a routine, or you have decided what the next call should cover.

Resolve every source into the `context` text before you park. The call cannot fetch documents, mail, or the knowledge graph. Say what is missing in the context rather than linking to it.

Keep `context` within 6,000 characters. Set `scheduled_for` when the call has a time, so a different call does not pick the agenda up early. Leave it unset when the agenda is for the next call whenever that is.

The principal can see and edit agendas under `/meetings/agendas/` in the console.

`/meetings/` holds agendas and minutes written by the meetings pipeline. It is durable and never task-owned. Agendas are edited through `meeting-agenda-park` or the console.
