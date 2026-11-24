# ADR-062: The budget specialist reads the owner's personal budget and changes nothing

Date: 2026-11-24
Status: Accepted

## Context

Curia now holds the owner's personal budget: categories with monthly budgets, imported transactions and a YAML of categorisation rules, all owner-only (`/api/budget`, migration 130). The owner wants the Digital EA to answer questions about it ("how am I doing on groceries?", "what is over budget?"). This is personal financial data, more sensitive than the company books, and it reaches a model and the audit log when an agent reads it.

Alternatives:

- **No agent access.** The console and the morning brief still work. Safest, but it rules out the EA answering budget questions, which the owner asked for.
- **Give the coordinator the tools directly.** Puts personal finance in the one agent that talks to everyone, and grows its always-on prompt. Every other domain uses a specialist (ADR-046, ADR-047, ADR-060).
- **A specialist that can also categorise and change budgets.** Useful, but changing the owner's budget or category is a different risk class from reading it.
- **A read-only specialist**, following the books pattern (ADR-060).

## Decision

Add a **`budget` specialist** (`agents/budget.yaml`) and a **`budget` skill bundle** (`skills/budget`), read-only:

- Tools: `budget-summary` (one month: budgeted, spent and remaining per category, state, totals, what needs the owner), `budget-needs-review` and `budget-transactions`. Each declares `action_risk: none`, `sensitivity: normal` and `allowed_callers: ["budget"]`, so only the specialist can call them.
- The tools reach the data through one capability, `budgetReader`, a facade (`src/budget/budget-reader.ts`) with no method that categorises, edits a budget, imports a file or touches the rules. A test fails if a method is added. Amounts leave it in dollars, because a model cannot convert cents reliably.
- The summary is computed once in `BudgetStore.summary()`; the console, the morning brief and the specialist all read it, so they cannot disagree.
- The coordinator reaches the specialist through `delegate` and the `delegate_when` roster line, and answers the principal itself. The specialist is principal-only and told so.
- It ships disabled, like `books` and `diagnostics`: the operator enables the agent and its skills in Settings. It is not in `config/registry-defaults.yaml`.
- The categorisation first pass is not this agent. It is a separate tool-less model step that applies the owner's YAML rules first (a later change), so a hostile payee name cannot steer an agent that has tools.

Changing a category or a budget, importing and editing rules stay with the owner in the console. Adding any of them to the agent is a new decision: a new method on `BudgetReader` or a separate write capability, an `action_risk` that matches, and a change to this ADR.

## Consequences

- The principal can ask the Digital EA about the budget like the calendar or the books.
- Whatever the specialist reads goes to the model and is written to the audit log, so personal balances, payees and amounts sit in the audit trail and in the EA's conversation. This is the cost of the feature; with other users on the instance it needs the multi-user access discussion first, and the specialist stays off until the operator enables it.
- Nothing structural stops the coordinator delegating a budget question that a non-principal triggered; the prompt and the coordinator's disclosure rules (ADR-054) hold that line. If that is not enough, the fix is a check in `delegate`, not `elevated` on the tools (see the ADR-060 amendment).
- Bank text (payee, description) is untrusted. The prompt treats it as data; read-only tools limit what a hostile description can do to disclosure inside the principal-only conversation.
