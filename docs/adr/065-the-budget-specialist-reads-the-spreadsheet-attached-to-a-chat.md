# ADR-065: The budget specialist reads the spreadsheet attached to a chat

Date: 2026-11-27
Status: Accepted (amends ADR-062; follows ADR-064)

## Context

The owner wants to discuss a budget spreadsheet with the EA before anything changes. ADR-062 made the budget specialist
read-only over the budget; ADR-064 stored spreadsheets that no agent could read.

## Decision

- A sheet is **attached to one web chat conversation** (`budget_sheets.conversation_id`, one per conversation), set only by
  the owner's authenticated console.
- The specialist reads it with `budget-sheet-read`, through a separate capability `budgetSheetReader`. The tool takes **no
  sheet or conversation id**: it uses the conversation recorded on the delegation (`delegationOrigin`, written only by
  `delegate`), and requires that origin to be the `web` channel and the run to be a delegated one. A stored sheet that is
  not attached to that chat cannot be reached.
- **Read-only.** The reader has no method that changes anything; ADR-062 otherwise stands.
- Cell text is untrusted: instruction-like tags are stripped, text matching the inbound injection patterns is flagged, and
  hidden tabs, rows and columns are left out and reported, since the owner cannot see what they hold.
- The coordinator gets a short note only on the owner's live web turn in a chat with a sheet attached.
- **Policy:** `/chat` alone additionally allows `frame-src 'self'`, so the sheet and the converter can sit beside the
  conversation (owner-approved). A policy is fixed when a document loads, so a chat reached by in-app navigation reloads
  once before attaching.

## Consequences

- What is read goes to the model provider and into audit logs and conversation memory; deleting the sheet does not erase
  those.
- Scanning is pattern matching and will not catch every attempt to steer an agent through cell text, during a turn in which
  the coordinator also holds powerful tools. The narrow tool limits what the specialist can do, not what it can say.
- Formula results are those last saved by the owner's browser.
- The `budget` agent and skill remain off until the owner enables them.
