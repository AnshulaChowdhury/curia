# Personal budget in the console: plan and proposed API

Status: Overview, Budgets and Import read and write the real `/api/budget/*` routes. The server's summary is the only source of spending totals and states; rollover is saved but not counted yet. The sections below are the original plan.

Personal finance is separate from the MowMow business books (the Books page). Owner-only.

## Routes (apps/console)

| Path | Page | First pass |
|---|---|---|
| `/budget` | Overview | built |
| `/budget/budgets` | Budgets | built |
| `/budget/transactions` | Transactions | next PR |
| `/budget/import` | Import | next PR |
| `/budget/rules` | Rules | next PR |
| `/budget/yearly`, `/budget/flow` | Yearly grid, Sankey | stub only |

Sidebar gets one "Budget" item. A small tab bar inside the pages switches between them.

## Components

- `BudgetOverviewPage`, `BudgetsPage`: pages.
- `MonthSelector`: previous/next buttons plus a labelled month input.
- `CategoryRow`: name, spent/budget, progress bar. The state is also written as text ("Under", "Near limit", "Over") and as an icon shape, so colour is never the only signal.
- `NeedsYouList`: uncategorised transactions and over-budget categories.
- `BudgetForm`: add/edit with labelled inputs. Delete asks for confirmation.
- `MoneyCard` (morning brief): a pure component that takes a `MoneySummary` prop and does no fetching, so it can later be reused in the phone app.

Logic lives in `pages/budget-utils.ts` (pure, unit tested): cents formatting, month maths, per-category status, rollover, needs-you list. Components only render.

## Fixture shape (integer cents, CAD, negative = money out, dates YYYY-MM-DD)

All fixtures are invented. No real payees, amounts or accounts.

```ts
interface BudgetCategory { id: string; name: string; monthlyCents: number; rollover: boolean }
interface BudgetTxn {
  id: string; date: string; payee: string; amountCents: number;
  categoryId: string | null; accountId: string;
  source: 'rule' | 'agent_guess' | 'you' | 'none';
  ruleId: string | null;
}
```

## Proposed API (all owner-only; 403 for every other principal, including agents)

Base `/api/budget`.

- `GET /categories`, `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id`. Body: `{ name, monthly_cents, rollover }`.
- `GET /summary?month=YYYY-MM`. Returns `{ month, total_spent_cents, total_budget_cents, categories: [{ id, name, budget_cents, spent_cents, rollover_in_cents }], needs_you: { uncategorised: n, over_budget: [ids] } }`. The server computes this so the phone app and the morning brief use the same numbers.
- `GET /transactions?month=&category=&account=&needs_review=`, `PATCH /transactions/:id` (`{ category_id }`, sets source to `you`), `POST /transactions/bulk-categorise`.
- `POST /imports` (upload `.qbo/.ofx/.csv`). Returns `{ added, duplicates_skipped }`.
- `GET/PUT /rules`, with each transaction carrying `rule_id` when a rule fired.

Rules:
- Money is integer cents everywhere. The server never returns floats.
- `source` is one of `rule | agent_guess | you`. The UI marks `agent_guess` as a guess and lets the owner override it.
- Bank text (payee, description) is untrusted. The server stores it as-is and the UI renders it as text only.
- Migrations: the front end needs none of its own choosing. web_dev should assign migration numbers.

## Agreed with web_dev

- `/summary` is computed server-side and returns per-category budgeted, spent and remaining in integer cents, plus needs-you counts (uncategorised, over budget).
- Transactions carry a stable id, `source` (rule | agent_guess | you), `rule_id`, and `confidence` when the source is `agent_guess`.
- `POST /imports` takes the raw file body with `?name=`, like `/api/books/uploads`, not multipart. The response gives added and duplicates-skipped counts.
- `/rules` is one document: `GET`/`PUT`, validated on save.
- Auth follows the Books pattern (`assertSecret`). The console treats 401 and 403 the same: a locked state, never partial data.
- Migrations 130-139 are reserved for budget tables. This PR adds none.
- No skill, tool or capability may expose budget data to agents without the owner's agreement.
- The phone app and its endpoints are out of scope.

## Original questions (answered)

1. Confirm the `/api/budget/*` shape above, or tell me what to change.
2. Who owns auth for "owner only", and how the console should tell the page it is forbidden.
3. A migration number range for the budget tables.
4. Confirm that the phone app is out of scope and that the `MoneyCard` summary props are enough for later reuse.
