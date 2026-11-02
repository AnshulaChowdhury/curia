# The books specialist

The principal's Digital EA (the coordinator) answers questions about the MowMow books by delegating to a read-only `books` specialist, the same way it delegates calendar questions to `calendar`. The decision and its limits are in [ADR-060](../adr/060-the-books-specialist-is-read-only.md).

## What it can do

| Tool | Returns |
|---|---|
| `books-summary` | QuickBooks cash, liabilities and receivable (dollars), the latest RBC batch and how many rows are matched in QuickBooks, rows needing review, files waiting, the last weekly run, when the books Mac mini last checked in |
| `books-review-queue` | The transactions waiting for the owner, with why each needs a person (limit 1 to 50) |
| `books-uploads` | Recent bank-file uploads and whether each was processed (never the file contents) |

It cannot approve a row, post to QuickBooks, upload or remove a file, edit a rule, or message anyone. Those stay with the principal on the Books page and on the Mac mini.

## Turning it on

Like `diagnostics`, it is not enabled by default (it reads financial data). In Settings, enable the `books` agent and the `books` skill bundle. Nothing else needs configuring: it uses the QuickBooks connection and books data that the Books page already uses.

## How it is wired

- `agents/books.yaml`: the specialist and its `delegate_when` roster line (kept to one short sentence: the coordinator's specialist roster has a 500-token budget).
- `skills/books/`: the bundle. Each tool declares the `booksReader` capability and `allowed_callers: ["books"]`.
- `src/books/books-reader.ts`: the read facade behind the capability. It has no write methods; `tests/unit/books/books-reader.test.ts` fails if one is added.
- `src/index.ts` builds the one `QboConnection` and shares it with the HTTP routes and the reader. Do not construct a second one: QuickBooks rotates the refresh token on every refresh.

## Adding a write

Not without a new decision. It needs a separate write capability (not a method on `BooksReader`), an `action_risk` that matches the action, owner approval for each call, and an update to ADR-060.
