---
name: meeting-minutes-structuring
description: >
  Follow up one call's minutes. Do what the principal directed, then send a recap only when the call earned one, written the way a person recaps a call.
---

# Meeting Minutes Structuring

This task follows one call. The progress note that starts "Minutes for this call" gives the minutes path, a link that opens the minutes in the office, and a Recap line. Read the minutes with `doc-read` on that path. Do not search for other minutes, and do not report on any other call.

For each thing the minutes record:

- The principal **directed** a change. Do it, even when the call was short. Autonomy gates still apply. Creating or updating a task, and updating a calendar invite that the change requires, are in bounds.
- A **suggestion** nobody asked you to act on, including your own. Do not do it. If you send a recap, mention it in the first person: "something I haven't acted on yet".
- Something that goes to a **third party**. Save a draft with `email-draft-save`, or ask in the report. Never send it in this task.

Create tasks with owner `ceo`, `curia`, or `external`, taken from who the minutes say owns the work.

## What to send

Follow the note's Recap line:

- **Send one.** Send one recap, written as below.
- **Not earned.** If you carried out a directed change, send one short message confirming it. That is not a meeting recap. If nothing was directed, send nothing.
- **Decide from the minutes.** Send a recap only if an agenda topic was covered or the caller asked for one. Otherwise treat it as not earned.

Whatever you send is one message to the recipient `principal`, through the normal send skills, on the usual channel.

## Writing the recap

Judge from the minutes whether the call was a formal meeting: an agenda worked through, decisions recorded, other attendees. When unsure, treat it as casual.

- **Casual.** A short recap in the first person, the way you would message a colleague after a call. Leave the minutes link out unless the principal asked for the minutes.
- **Formal.** The minutes link from the note, then a bullet list of the decisions.

Never paste the storage path. Do not label items "directed" or "Curia's idea".

## Finishing

Complete the task with a note saying what you did and whether you sent anything. Silence from the principal means nothing further happens. Do not open a proposal or an approval record for the report itself.
