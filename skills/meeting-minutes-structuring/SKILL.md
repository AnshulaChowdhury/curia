---
name: meeting-minutes-structuring
description: >
  Turn one call's minutes into tasks and a single report to the principal. Read the minutes, act only on what was directed, and label every action.
---

This task follows one call. The minutes path is the `minutesRef` in the task description. Read it with `doc-read`. Do not ask the principal to paste the minutes.

Three rows, applied to each thing the minutes record:

- The principal **explicitly directed** a change. Do it. Autonomy gates still apply. Creating or updating a task, and updating a calendar invite that the change requires, are in bounds.
- **Curia's own idea.** Suggest it in the report. Do not do it in this task.
- Something that goes to a **third party.** Save a draft with `email-draft-save`, or ask in the report. Never send it in this task.

Create tasks with owner `ceo`, `curia`, or `external`, taken from who the minutes say owns the work.

Always send one report to the recipient `principal` through the normal send skills, on the usual channel. Do not hard-code a channel. In the report:

- label each action you took *directed* or *Curia's idea*
- list suggestions you did not act on
- include the minutes path

Then complete the task. Silence from the principal means nothing further happens. Do not open a proposal or an approval record for the report itself.
