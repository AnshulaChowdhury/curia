# ADR-060: The books specialist reads the books and changes nothing

Date: 2026-11-02
Status: Accepted

## Context

The MowMow bookkeeping system lives in two places: a Python program on the books Mac mini, and Curia, which holds the QuickBooks connection, the review queue, the uploaded bank files and the monitor (ADR-059 covers the rules graph). Neither was an agent. The coordinator (the principal's Digital EA) had no specialist to hand a books question to and no tool that read books data, so "how much cash do we have?" or "what is waiting for me?" had no answer path, unlike calendar, contacts, ceo-inbox and diagnostics, which each have a specialist and a skill bundle.

The question was how to expose the books, and how much to let an agent do. The data is the principal's financial information, and the actions behind it (approving a row, posting to QuickBooks, uploading a bank file, changing a rule) change the company's books. Alternatives:

- **Give the coordinator the tools directly.** Fast, but it puts financial data and any later write into the one agent that talks to everyone, and grows its always-on prompt. Every other domain uses a specialist (ADR-046, ADR-047).
- **A specialist that can also approve and post.** Useful, but approving and posting are a different risk class from reading. The weekly flow deliberately keeps them with the owner (review on the Books page, a dry-run-first posting step on the Mac mini), and `action_risk: critical` exists for exactly this kind of action.
- **A read-only specialist**, following the diagnostics pattern: its own agent file, its own skill bundle, tools callable only by it.

## Decision

Add a **`books` specialist** (`agents/books.yaml`) and a **`books` skill bundle** (`skills/books`), read-only:

- Tools: `books-summary` (QuickBooks cash, liabilities and receivable, the latest batch and how many rows are matched, rows needing review, files waiting, the last weekly run, when the Mac mini last checked in), `books-review-queue` and `books-uploads`. Each declares `action_risk: none` and `sensitivity: elevated`, and `allowed_callers: ["books"]`, so only the specialist can call them.
- The tools reach the data through one new capability, `booksReader`, a facade (`src/books/books-reader.ts`) that has no method that approves, posts, uploads, removes, edits a rule or touches the vault. A test fails if a method is added to it.
- The coordinator reaches the specialist the usual way, through `delegate` and the `delegate_when` roster line, and answers the principal itself (borrow-then-answer). The specialist is principal-only.
- QuickBooks is read through **the process's single `QboConnection`**, now built in `index.ts` and shared with the HTTP routes. QuickBooks rotates the refresh token on every refresh, so two connections in one process could each refresh and invalidate the other's token.
- Like diagnostics, the specialist and its bundle ship disabled on an existing deployment: the operator enables them in Settings, and they are not in `config/registry-defaults.yaml`.

Approving, posting, uploading and editing rules stay with the principal. Adding any of them to the agent is a new decision: it would need a new method on `BooksReader` or a separate write capability, an `action_risk` that matches the action, and a change to this ADR.

## Consequences

- The principal can ask the Digital EA about the books in the same way as about the calendar, and the answer comes from the live QuickBooks balances and the review queue, not from memory.
- The agent can see the principal's bank descriptions and balances. They are returned to the model and, like all tool results, are written to the audit log. The review queue's bank text is untrusted and the prompt says to treat it as data, but a hostile description could still try to steer the model. Read-only tools limit what that can do to disclosure within the principal-only conversation.
- A QuickBooks outage or a lapsed connection comes back as a note in the summary, not an error, so the agent can say so instead of guessing.
- The coordinator's specialist roster has a 500-token budget (`prompt-budget.test.ts`). The books line fits only because it is one short sentence; a further specialist will need the lines trimmed or the budget raised deliberately.
- There is no free-form QuickBooks query tool. Questions the three tools cannot answer (for example a single vendor's history) have no path yet; adding one means choosing which QuickBooks entities an agent may read.
- ADR-059's graph snapshot is unchanged and is not exposed to the agent.
