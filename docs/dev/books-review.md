# Books review

The weekly books run (on the Mac mini) turns the bank files into a **batch** of rows. Curia stores the batch, the owner reviews it on **Books** in the console, and the books agent pulls the approved rows, posts them to QuickBooks and reports what happened.

```
Mac mini ── POST /books/batches ──────────▶ Curia (books_batches, books_batch_rows)
                                              │  owner: edit, approve, skip on the Books page
Mac mini ◀── GET /books/batches/approved ─────┘
Mac mini ── POST /books/batches/:id/results ▶ Curia (posted / manual / failed / skipped per row)
```

## Rules

- A row is stored exactly as pushed (`data`). The owner's changes live in `edits` (only `category`, `tax_code`, `location`, `class`, `payee`; text up to 200 characters) and are merged over `data` when read. Pushing the same batch id again adds new rows and refreshes the report, but never touches an edit, a decision or a result; a row's pushed data is refreshed only while it is still pending and not posted.
- Decision per row: `pending`, `approved`, `skipped`. A row with an open `needs_category`, `row_error`, `unpaired_transfer`, `amount_differs` or `date_differs` flag cannot be approved while it has no category. Approving several rows is all or nothing.
- The agent only receives rows that are approved and have no result yet. Results: `posted` is final and locks the row (no edit, decision change or second result); `failed` and `manual` send the row back to pending with the message shown; `skipped` closes it. Approving a row again clears an earlier failed or manual result.
- Row text comes from bank files and is untrusted: it is stored and returned as JSON and shown as plain text, never as HTML.

## Routes

Books token (`Authorization: Bearer <books token>`, same token as `/books/qbo/*`; 404 until one exists):

| Route | Body | Returns |
|---|---|---|
| `POST /books/batches` | `{batch: {batch_id, revision, rows: [...]}, report: {...}}`, up to 2000 rows and 2 MB; `batch_id` is 8 to 64 hex characters; every row needs string `id`, `amount`, `date`, `description` | `{ok, rows}` |
| `GET /books/batches/approved` | | `{batches: [{batch_id, rows: [row with edits merged, id included]}]}` |
| `POST /books/batches/:id/results` | `{results: {rowId: {status: posted\|manual\|failed\|skipped, qbo_id?, entity?, message?}}}` | `{ok, recorded, ignored: [rowIds]}` (ignored: not approved, already reported, or unknown) |

Signed-in owner (session cookie or bootstrap secret):

| Route | Body | Returns |
|---|---|---|
| `GET /api/books/batches` | | `{batches: [{batch_id, created_at, status, rows, pending, approved, skipped, posted, failed, manual, report}]}` |
| `GET /api/books/batches/:id` | | `{batch_id, created_at, status, report, rows: [{id, row, decision, result, edits}]}` |
| `PATCH /api/books/batches/:id/rows/:rowId` | `{edits: {category?, tax_code?, location?, class?, payee?}}` (null or empty removes an edit) | `{row}` |
| `POST /api/books/batches/:id/decide` | `{row_ids: [...], decision: approved\|skipped\|pending}` | `{ok, updated}` |

Errors: 400 bad input or a row that cannot be approved (the message says why), 404 unknown batch or row, 409 the row is posted or no longer pending.

## Accounting graph snapshot

The books Mac mini keeps the rules in an Oxigraph graph (`mowmowaccounting`, `docs/graph.md`) and pushes a read-only snapshot for the Knowledge Graph page (ADR-059).

- `POST /books/graph` (books token) body `{"snapshot": {version?, generated_at?, nodes: [...], edges: [...]}}` returns `{ok, nodes, edges}`. Nodes: `id`, `type`, `label` required; optional `properties` (flat: text, numbers, booleans, null, short lists), `confidence` (0 to 1), `decayClass`, `source`, `sensitivity`, `createdAt`, `lastConfirmedAt`, `aliases`, `archived`. Edges: `id`, `sourceNodeId`, `targetNodeId`, `type`; optional `confidence`, `decayClass`, `source`, `createdAt`, `lastConfirmedAt`. Unknown fields, duplicate ids, edges to missing nodes, more than 5000 nodes / 20000 edges or more than 2 MB are refused with 400 and a message. Only the latest snapshot is kept (`books_graph_snapshot`).
- `GET /api/books/graph` (signed in) returns `{snapshot, received_at}` or `{empty: true}`.
- The page: Knowledge Graph → Accounting (`/kg?graph=accounting`). Rule nodes are rounded squares coloured by what they assign; proposed rules have a dashed outline, retired ones a struck-through label.

