# ADR-069: Projected net worth is worked out by Curia and shown with proposals

Date: 2026-11-27
Status: Accepted (amends ADR-062 and ADR-067)

## Context

The owner wants to see, while changing a budget in chat, what the changes do to net worth. Net worth today comes from
account balances; a budget changes only where it is heading.

## Decision

- **One calculation in code** (`projection.ts`): today's net worth plus income minus expenses, month by month from next
  month. **Savings is money kept** and covers paying down debt, so it takes nothing away. No interest, investment
  growth or change in property value.
- The proposal card shows it **with the waiting changes included**, recalculated by the server after each saved edit.
  The owner can correct a row's type on the card.
- The budget specialist gets the same figures from `budget-propose` and a read-only `budget-net-worth`. It is told to
  quote them, not to add them up.
- The savings type is labelled **Savings & debt paydown**; no new type or migration.

## Consequences

- The specialist now sees **net worth, asset and debt totals**, which go to the model provider. No account, bank or
  balance line is given.
- A projection is only as good as the balances entered and the budget's completeness: a month with no income budgeted
  looks like pure loss. Interest on debt is missed unless budgeted as an expense.
- The specialist can still repeat a figure wrongly; the card is the record.
