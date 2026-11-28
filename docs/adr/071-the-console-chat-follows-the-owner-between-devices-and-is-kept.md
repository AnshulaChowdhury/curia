# ADR-071: The console chat follows the owner between devices and is kept

Date: 2026-11-28
Status: Accepted

## Context

The console remembered which chat was open only in the browser, so a second laptop started an empty one. Summarised
messages were hidden from the screen, unarchived messages expired after 30 days, and the AI call archive after 90. The
owner wants one chat on every device and all of it kept.

## Decision

- `GET /api/chat/current` names the web chat a person last wrote in. The console opens that one and falls back to its
  own memory only if the server has none or cannot be reached. The web channel is the owner's alone.
- Chat history includes summarised (archived) messages. The assistant still reads the summary in their place.
- Conversations with a web-channel turn never expire. Other conversations keep the 30-day limit.
- The AI call archive is kept unless `audit.llmCallArchive.hotRetentionDays` is set.

This follows ADR-070: secrets are removed before anything is stored.

## Consequences

- The database grows without limit, mostly through the AI call archive: every model call, prompts included.
- Private content stays until someone deletes it. There is no deletion screen.
- Messages already purged or archive rows already deleted do not come back.
- A second open tab shows another device's messages after a reload, not live.
