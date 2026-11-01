# QuickBooks connection (books)

Curia owns the MowMow QuickBooks authorisation. The books agent on the Mac mini holds no QuickBooks token; it calls `/books/qbo/*` with its own token.

## Settings (Railway variables on the curia service)

| Variable | Value |
|---|---|
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | From the existing production Intuit app (Keys & credentials) |
| `QBO_REDIRECT_URI` | `https://os.moonray.ventures/books/qbo-callback` — add the same address to the Intuit app's production redirect URIs |
| `QBO_ENVIRONMENT` | `production` (default) or `sandbox` |
| `BOOKS_API_TOKEN` | A long random string; the books agent sends it as `Authorization: Bearer ...`. Unset → the machine routes return 404 |

## Connecting

Sign in to Curia, then open `https://os.moonray.ventures/books/qbo/connect` and approve as an admin of the MowMow company. The tokens are stored encrypted in the vault as `qbo_tokens`. QuickBooks rotates the refresh token on every refresh and it lapses after 100 days unused, so only Curia may refresh; repeat the step if `/books/qbo/status` reports `connected: false`.

## Routes

- `GET /books/qbo/status` — connected or not (no tokens).
- `POST /books/qbo/query` `{query}` — one `select ... from <entity>` on Account, Class, Department, TaxCode, Vendor, Customer, Purchase, Deposit, Transfer, Preferences, CompanyInfo, Item.
- `POST /books/qbo/create` `{entity, payload, request_id}` — Purchase, Deposit, Transfer or Vendor; QuickBooks de-duplicates on `request_id`.

Errors: 409 `not_connected` (connect again), 422 QuickBooks refused the entry (message and fault included), 502 QuickBooks unavailable.
