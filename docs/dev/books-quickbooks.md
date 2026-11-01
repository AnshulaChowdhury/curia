# QuickBooks connection (books)

Curia owns the MowMow QuickBooks authorisation. The books agent on the Mac mini holds no QuickBooks token; it calls `/books/qbo/*` with its own token.

## Setting up (all on the API connections page)

Settings → **API connections** has three steps:

1. **The Intuit app.** Enter the app's production client ID and secret (developer.intuit.com → the app → Keys & credentials). First add the redirect address shown on the form (`https://<your Curia>/books/qbo-callback`) to the app's Redirect URIs. The secret is stored encrypted in the vault (`qbo_settings`) and never shown again. Changing to a different client ID drops the old connection.
2. **Authorise.** Press Connect, sign in to Intuit as an admin of the company and approve. The tokens are stored encrypted in the vault as `qbo_tokens`. QuickBooks rotates the refresh token on every refresh and it lapses after 100 days unused, so only Curia may refresh; press Reconnect if the page shows Not connected.
3. **Books agent token.** Press Make a token and copy it into the books user's secrets file on the Mac mini as `BOOKS_API_TOKEN`. It is shown once; only its SHA-256 is kept (`books_api_token_hash`).

Railway variables still work as a fallback: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT` (default `production`) and `BOOKS_API_TOKEN`. Values saved on the page win over them, and a generated token replaces `BOOKS_API_TOKEN`. Without a token the machine routes return 404.

## Routes

- `GET /books/qbo/status` — connected or not (no tokens).
- `POST /books/qbo/query` `{query}` — one `select ... from <entity>` on Account, Class, Department, TaxCode, Vendor, Customer, Purchase, Deposit, Transfer, Preferences, CompanyInfo, Item.
- `POST /books/qbo/create` `{entity, payload, request_id}` — Purchase, Deposit, Transfer or Vendor; QuickBooks de-duplicates on `request_id`.

Errors: 409 `not_connected` (connect again), 422 QuickBooks refused the entry (message and fault included), 502 QuickBooks unavailable.
