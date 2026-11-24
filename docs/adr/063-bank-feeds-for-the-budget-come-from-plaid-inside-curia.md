# ADR-063: Bank feeds for the personal budget come from Plaid, called by Curia itself

Date: 2026-11-24
Status: Accepted

## Context

The owner wants bank transactions in the personal budget without uploading files. Tangerine and CIBC offer no API or MCP server of their own, and Canada's consumer-driven banking is not live. Plaid supports Canadian institutions, including both. The open-source `personal-finance-mcp` repo wraps Plaid for a single user on one machine, with a local-only link helper.

Alternatives:

- **Run `personal-finance-mcp`.** A second service to host and secure, one tenant, and transactions would still have to be copied into the budget tables.
- **File imports only.** Works today (RBC, Tangerine, CIBC, OFX/QBO files) and needs no third party, but is manual.
- **Call Plaid from Curia.** One more outside dependency, but the data lands straight in `budget_transactions` through the existing dedupe, and the credentials sit in the vault with everything else.

## Decision

Curia calls Plaid's REST API directly (`src/budget/plaid-client.ts`, no SDK) and keeps file import as the fallback.

- **Credentials** are three vault entries, `plaid_client_id`, `plaid_secret` and `plaid_env` (`sandbox` or `production`), read on every call. Nothing runs until both the id and the secret exist.
- **The per-bank access token** is stored only in the encrypted vault (`plaid_access_<link id>`). `budget_bank_links` (migration 131) holds the institution, account labels, sync cursor and status, never the token. No route returns it.
- **Owner-only routes** under `/api/budget/banks` create the Link token, store a connection, sync and disconnect. The browser runs Plaid Link; it only ever holds the short-lived public token.
- **Sync** runs every six hours and on demand. Only settled transactions are imported, because a pending one is re-issued under a new id when it settles. Plaid reports money out as positive; the budget stores it negative. The cursor is saved after each page, so a failed sync resumes where it stopped. A bank asking the owner to log in again marks the link `needs_login`.
- **Identical purchases** stay separate: the transaction's Plaid id is added to the dedupe fingerprint, only when present, so every fingerprint already stored is unchanged.
- **No agent can reach any of it.** The budget specialist's reader (ADR-062) has no bank methods, and the Plaid client is not exposed as a capability.

## Consequences

- Plaid is a third party that sees which banks are linked and returns transaction data. It needs the owner's Plaid account, and production access for Canadian banks needs Plaid's approval, which this change does not assume.
- Categorisation of imported rows is a separate step; until it exists they arrive uncategorised and show under "needs you".
- Disconnecting revokes the item at Plaid and deletes the stored token; if Plaid refuses, the link and token are still removed locally.
