# Phone inbox endpoint (`GET /phone/inbox`)

Read-only summary of email that "needs you", for the Command Hub Android launcher. The contract lives in the
MVOS repo (`contracts/phone-inbox.openapi.yaml`); this is how Curia serves it.

## What it returns
Per mailbox (`personal`, `moonray`, `work-outlook`; always all three): the unread inbox messages tagged
**Urgent**, **Drafted** or **Seen** by the `ceo-inbox` triage, newest first, one per thread, minus any thread
you replied to after the message arrived (sent mail from the last 14 days is checked). Only sender, subject,
group, time and ids. Never bodies, snippets or attachments. State is read from Nylas on every request.

If any configured mailbox can't be read the whole answer is a 502, so the phone keeps its cached list instead of
showing a false "0 need you".

## Auth
Its own bearer token, vault secret `phone_inbox_token`. It sits outside `/api`, so `api_token` does not work
here and the phone token works on nothing else. With no token in the vault the route answers 404.

## Vault secrets
| Secret | Purpose |
|---|---|
| `phone_inbox_token` | Bearer token entered on the phone |
| `nylas_api_key` | Shared Nylas key (already used by email) |
| `nylas_region` | `us` (default) or `eu`: where the Nylas application lives. Must match, or Nylas answers 401 |
| `phone_inbox_grant_personal` / `_moonray` / `_work_outlook` | Nylas grant id per mailbox |
| `phone_inbox_address_personal` / `_moonray` / `_work_outlook` | Address shown on the phone (optional; `null` until set) |

A mailbox without a grant (or without the Nylas key) is listed with `syncing: false` and zero counts, so the phone
can show "not syncing" instead of "nothing needs you". Work Outlook is expected to be in this state if the employer blocks
third-party access. Seed with `pnpm run seed-vault`.

## Needs the triage to cooperate
- **Decision tagging on** (`ceo_inbox/decision_tagging`) so the groups exist as labels.
- **Seen mail must stay unread** (label only). Today `ceo-inbox` marks Seen mail read, so it won't appear until that changes.
- **Gmail thread ids:** `threadId` is Nylas's `thread_id`. Confirm on a Google grant that it is Gmail's hex thread id; the phone
  builds `mail.google.com/mail/u/<address>/#all/<threadId>` from it.
