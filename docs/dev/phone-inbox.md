# Phone inbox endpoints (`GET /phone/inbox`, `GET /phone/message`)

Read-only summary of email that "needs you", for the Command Hub Android launcher. The contract lives in the
MVOS repo (`contracts/phone-inbox.openapi.yaml`); this is how Curia serves it.

## What it returns
Per mailbox (`personal`, `moonray`, `work-outlook`; always all three): the unread inbox messages tagged
**Urgent**, **Drafted** or **Seen** by the `ceo-inbox` triage, newest first, one per thread, minus any thread
you replied to after the message arrived (sent mail from the last 14 days is checked). Only sender, subject,
group, time and ids. Never bodies, snippets or attachments. State is read from Nylas, never by scanning the inbox: it lists the
folders (which also gives the inbox's unread total), then asks only for each triage tag's unread mail. Google limits queries per
user per minute and Nylas passes reads through, so large scans trigger 429s.

Each mailbox is cached in memory for a minute, so refreshing the phone doesn't hammer Nylas. If a mailbox can't be read, its
last good answer is served for up to 30 minutes, then it is reported as `syncing: false` (never as "0 need you"). Other
mailboxes are unaffected. On a Nylas 429 the mailbox is left alone for at least a minute (or its `Retry-After`). Calls to one
mailbox are made one at a time.

## The text of one email (`GET /phone/message`)
`GET /phone/message?account=<personal|moonray|work-outlook>&threadId=<id>&messageId=<optional>` returns
`{ "body": "<plain text>", "truncated": false }` for the email page in Command Hub. The phone asks only when the owner opens
an email. `/phone/inbox` itself still never returns bodies.
- One Nylas read per request. With a `messageId` it reads that message (404 if it belongs to another thread); without one it
  lists the thread (10 messages) and returns the newest one that is not in Sent or Drafts.
- HTML is converted to plain text (`htmlToText`), then cut at 20,000 characters and flagged `truncated`. No images or attachments.
- The body is never logged, cached or stored, and the response is `Cache-Control: no-store`. Errors log the HTTP status only.
- 404 when the email is gone, is not in that mailbox, or the mailbox has no Nylas grant. 400 for a missing or bad parameter.
  502 when Nylas fails, 503 (with `Retry-After` when Nylas gave one) when it rate-limits.

## Auth
One bearer token, vault secret `phone_inbox_token`, shared by `/phone/inbox` and `/phone/message` (owner's decision,
2026-11-02). Because it now also unlocks email text, treat it as sensitive: a leaked token exposes the text of any email you
can name by thread id. It sits outside `/api`, so `api_token` does not work here and the phone token works on nothing else.
With no token in the vault both routes answer 404.

## Vault secrets
| Secret | Purpose |
|---|---|
| `phone_inbox_token` | Bearer token entered on the phone; works for `/phone/inbox` and `/phone/message` |
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
