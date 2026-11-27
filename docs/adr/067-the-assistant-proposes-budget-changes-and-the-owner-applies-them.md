# ADR-067: The assistant proposes budget changes; the owner's console applies them

Date: 2026-11-27
Status: Accepted (amends ADR-062)

## Context

The owner asks in chat for budget categories and monthly amounts to be created from an attached spreadsheet. ADR-062
made the budget specialist read-only. With nothing able to write, the assistant can claim to have created categories
when no tool has run.

## Decision

- The specialist gets **one write: a proposal** (`budget-propose`, capability `budgetProposer`, which exposes `propose`
  alone), only on a delegated request from the web chat.
- A proposal changes **no budget**. It records new, changed and archived categories with amounts by month, and how each
  stood at that moment. One waits per conversation, for 24 hours; a new one replaces it.
- The chat shows it as a **card drawn from storage**. The owner approves with the card's button or by replying "yes",
  which the console handles itself. **Only the signed-in owner's routes apply a proposal. No agent or tool can.**
- The owner may **edit amounts on the card** first; edits are saved to the proposal through the owner's routes.
- Applying is one transaction; if any category differs from when it was proposed, nothing is applied.
- Not covered: moving transactions between categories, deleting categories, editing spreadsheets.

## Consequences

- The model never holds a way to change the budget, so text in a spreadsheet cannot cause a change by itself. It can
  still shape a proposal: the owner has to read the card.
- The assistant can still claim wrongly in words that something happened. Its instructions forbid it; the card and the
  Budgets page are the record.
- "yes" counts only while a card is on screen, and only when it is the whole message. A spoken or phone "yes" does
  nothing.
- The assistant's conversation history does not record the approval; it reads the budget to find out.
