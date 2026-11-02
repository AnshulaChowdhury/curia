# Books in the Morning Brief

The Morning Brief (`GET /phone/brief`, built by the session that owns the `/phone/*` routes) has an **Accounting update** section. This module supplies it; the route calls it and drops the section when it returns `null`.

## The section: five lines

`accountingBrief(deps)` in `src/books/brief-section.ts` (wire it with `accountingBriefProvider({ batches: new BatchStore(pool), qbo: connection, logger })`):

1. `Cash in bank: $12,345.67` — sum of QuickBooks `Bank` accounts.
2. `Liabilities: $3,210.00` — Accounts Payable, Credit Card, Other Current Liability and Long Term Liability accounts (amount owed).
3. `Accounts receivable: $1,500.50`.
4. `Transactions in RBC (latest files): 64` — rows in the newest batch.
5. `Matched in QuickBooks: 58` — of those, rows already booked in QuickBooks (`already booked` / `TIMING`) or posted by the books agent.

If QuickBooks is not connected (or unreachable) lines 1-3 are replaced by one line saying so. Before the first bank file, lines 4-5 are omitted. If nothing at all can be said the function returns `null`.

"Matched" is deliberately not called "reconciled": QuickBooks does not expose reconciliation status through its API, and the books policy is to clear monthly and reconcile only at year end.

## Details page: transactions to review

When transactions need the owner, the result also carries `details: { path: '/phone/books/review', title: 'Transactions to review', count }`. The phone opens that path:

`GET /phone/books/review` — same bearer token as `/phone/inbox` (`phone_inbox_token`); 404 until it exists, 401 if wrong; `Cache-Control: no-store`. Read-only.

```json
{ "generatedAt": "2026-11-03T11:30:00Z", "count": 3,
  "cards": [ { "id": "…", "batchId": "abcdef12", "date": "2026-11-02", "description": "MYSTERY VENDOR LTD", "amount": "-12.00",
               "account": "RBC chequing", "category": null, "categorySource": "Needs your input", "taxCode": null,
               "location": null, "reasons": ["Needs a category"] } ] }
```

Up to 50 cards, newest transaction first. A card is a row that is undecided, or approved but could not be posted. `description` is bank text: untrusted, capped at 120 characters, control characters removed, plain text only. The account is words (`RBC chequing`), never a number. Approving or editing stays on the Books page.
