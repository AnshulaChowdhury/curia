# Phone endpoints (`GET /phone/inbox`, `GET /phone/message`, `GET /phone/brief`)

Read-only summary of email that "needs you", for the Command Hub Android launcher. The contract lives in the
MVOS repo (`contracts/phone-inbox.openapi.yaml`); this is how Curia serves it.

## What it returns
Top level: `updatedAt`, `accounts`, and `assistantName`: the executive assistant's full name from the office identity (one
line, at most 80 characters, `null` if unknown). The phone shows the first word in "morning brief from …" and falls back to
"Curia" when the field is missing, so it is optional for older phones.
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

## The morning brief (`GET /phone/brief`)
`{ date, generatedAt, signalNumber, sections: [{ id, items: [{ text?, from?, subject? }] }] }`, for the Command Hub Home row.
Sections are `accounting`, `contacts`, `newsletters`, `unsorted`, always in that order, only those with items, at most 10 items each, text
at most 280 characters, plain text. `204` when there is nothing to report; `404` with no token. It never serves a previous
day's brief.
- **Built once a day** at 06:30 in the configured timezone (`TIMEZONE`, default America/Toronto) by `PhoneBriefScheduler`, and
  stored in `phone_briefs` (one row per local date, 30 days kept). A restart after 06:30 and before noon still builds it; a failed
  build is retried up to three times, ten minutes apart. An empty day is stored too, so the job does not rerun.
- **`signalNumber`** is the number the Signal channel runs on (`SIGNAL_PHONE_NUMBER`), only if it is E.164, else `null`.
- **Newsletters:** yesterday's mail (local day) that triage labelled `Newsletter`, newest first. Each item has sender, subject and a
  one-to-two sentence summary written by the fast model from the email's text (the only place email text leaves Curia for the
  brief; no tools, links and markdown stripped). If the summary fails the item has sender and subject only.
- **Unsorted:** mail triage could not sort (the classifier said `none`, the call failed, or the label could not be written), one
  item per email with sender, subject and why. Not limited to yesterday: it lists everything still waiting, until the owner sorts it.
- **Other sections** are supplied by their owners: `PhoneBriefService.registerSource({ id, items(ctx) })` with `ctx.yesterday`
  as the local-day window. A source that throws loses only its own section. Counts only for accounting and contacts (no amounts,
  bank text or contact details).
- The same `phone_inbox_token` as the other phone routes.

## Marking mail read from the phone (`POST /phone/inbox/read`)
When the owner marks mail as seen in Command Hub, the phone also asks Curia to mark the whole thread READ in the mailbox
(owner-approved, 2026-11-02). Body `{ items: [{ account, threadId }] }`, 1 to 50 items (`threadId` as in `/phone/inbox`; duplicates
are ignored). Curia sends only `{ unread: false }` to the thread: it never marks mail unread, never changes triage labels, never
archives or deletes. Idempotent; a thread that no longer exists counts as done.
- `200 { ok: true, marked, failed, failedItems: [{ account, threadId }] }`: `marked` and `failed` are counts, `failedItems` lists the
  threads to retry (also the ones in a mailbox that is not connected).
- `400` bad input (nothing is written), `401` bad or missing token, `404` no token configured, `502` nothing could be written
  (the phone keeps the mark local and retries; `error` is "Mailbox busy" when Nylas rate-limited), `503` no listed mailbox is connected.
- The mailbox's cached `/phone/inbox` answer is dropped after a successful write, so the thread stops counting on the next poll.

## Sorting unsorted mail from the phone (`/phone/triage/review`)
Triage looks at every inbox email received since 2026-11-01 (local), read or unread. Mail it cannot sort stays unlabelled and is kept
in `inbox_triage_items` (sender, subject, a 300-character preview; cleared once resolved).
- `GET /phone/triage/review` → `{ generatedAt, count, cards: [{ id, account, messageId, threadId, from, subject, preview, receivedAt,
  reason: "none"|"failed", options: [{ group, label }] }] }`, newest first, at most 50. `options` are always `urgent`, `drafted`,
  `seen`, `newsletter`, `spam` (labels as in Gmail: Urgent, Needs a reply, FYI no action needed, Newsletter, Likely spam) and `dismiss`.
- `POST /phone/triage/review` with `{ account, messageId, group }` applies that label in the mailbox (newsletter and spam are also
  marked read) and removes the card; `group: "dismiss"` removes it and leaves the mail alone. `{ ok, id, remaining }` on success;
  400 bad input, 404 not waiting (so a double tap does nothing), 502 the mailbox write failed (card stays), 503 mailbox not connected.
- Mail the owner had already read before triage saw it is labelled but never pings the phone.
- After a category is chosen the answer may also carry `savePrompt: { group, question, options: [{ scope: "sender"|"domain", value, label }] }`
  (no domain option for shared providers like gmail.com; no `savePrompt` when the sender's address is unknown or for `dismiss`).
  The phone asks the owner "Save this for next time?" and, on yes, calls `POST /phone/triage/preferences`. "Not now" is just not calling it.

## Remembering a choice (`/phone/triage/preferences`)
Only the owner's yes saves anything. A saved preference is given to the classifier as `Earlier choice: <label>` for mail from that
sender (an exact address beats its domain, per mailbox). It is a hint the model weighs, not a rule: urgent still wins for time-critical
mail. Stored in `inbox_triage_preferences` (address or domain, group, dates; no mail text).
- `POST /phone/triage/preferences` with `{ account, scope: "sender"|"domain", value, group }` saves it (`{ ok: true }`). `400` for an
  unknown account/group, a value that is not a lower-case address (sender) or a non-shared domain (domain).
- `GET /phone/triage/preferences` → `{ preferences: [{ account, scope, value, group }] }`.
- `POST /phone/triage/preferences/forget` with `{ account, scope, value }` removes one: `204`, or `404` if it was not saved.

## Unsubscribing from a newsletter (`POST /phone/unsubscribe`)
`{ account, messageId }`. Curia reads the email's `List-Unsubscribe` header and always answers `200 { result }` (`Cache-Control: no-store`):
- `unsubscribed`: the sender supports one-click unsubscribe (RFC 8058) and accepted Curia's request.
- `open-link` + `url`: no one-click support; the phone opens the sender's page for the owner. Curia sends nothing.
- `open-mailto` + `mailto`: the sender only offers an address; the phone opens it for the owner. Curia never sends the email itself.
- `failed` (+ `url`): the one-click request was refused or timed out (or the link was not a public https address); open `url` instead.
- `none`: no unsubscribe information in this email.

Errors: `400` bad input, `404` message gone, `429` mailbox busy, `502` mailbox error, `503` mailbox not connected. Rate limit 10/min.
The link comes from the sender, so Curia only POSTs to an https link on a named public host (port 443, no login in the URL, no redirects),
checking every resolved address at connect time. The full link is never logged, only the host name.

## Auth
One bearer token, vault secret `phone_inbox_token`, shared by `/phone/inbox`, `/phone/message`, `/phone/brief`, `/phone/books/review`, `/phone/triage/review`, `/phone/triage/preferences`, `/phone/unsubscribe` and `/phone/inbox/read` (owner's decision,
2026-11-02). Because it now also unlocks email text, treat it as sensitive: a leaked token exposes the text of any email you
can name by thread id. It sits outside `/api`, so `api_token` does not work here and the phone token works on nothing else.
With no token in the vault the phone routes answer 404.

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
