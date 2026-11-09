# Contacts export (Matrix message activity)

Runs on the Mac mini as its own macOS user (see `ops/local-jobs/setup-local-job`). Reads the owner's Matrix chats and sends
**only counts** to Curia: for each chat partner, how many messages they sent, how many the owner sent, first and last seen.
Message text is never stored, logged or sent; room ids are sent only as a 16-character hash.

Standard library only, so it runs on Apple's `/usr/bin/python3` (3.9) with no `pip`.

## Settings (in `~/.contacts-env`, mode 600)
| Name | What |
|---|---|
| `CONTACTS_API_TOKEN` | Curia import token (Settings → API connections → Contacts import; shown once) |
| `CURIA_URL` | e.g. `https://curia.example.com` |
| `MATRIX_ACCESS_TOKEN` | A separate Matrix login for this job. **It can read every chat**; this is the approved exception to "Curia holds third-party credentials". |
| `MATRIX_HOMESERVER_URL` | The Synapse client address |

## Contract (bearer: the import token; the mini only calls out)
- `GET /contacts/export/ping` → `{ok:true}` (the installer's check)
- `GET /contacts/export/run-request` → `200 {runId, since, doneRooms:[hash]}` or `204` when nothing is asked
- `POST /contacts/export/rooms` `{runId, rooms:[{roomHash, network, members:[{ghostId, displayName?, phone?, fromThem, fromMe, firstSeen?, lastSeen?}]}]}` — absolute counts per room, so re-sending replaces; at most 50 rooms per call; unknown fields are refused
- `POST /contacts/export/log` `{runId?, lines:[{level:'info'|'warn'|'error', message}]}` — status lines for the console's job log (at most 50 lines of 400 characters; Curia keeps the newest 500). They may name chat partners, phones and room ids; they never contain message text.
- `POST /contacts/export/finish` `{runId, status:'done'|'failed', errorKind?}`

A run is requested from the console (`POST /api/contacts/export/request`, ten years back). The job polls; if the mini was off it
picks the request up when it returns. A restarted job skips rooms already marked done.

## What is counted
Only rooms with bridge partners (`@whatsapp_…`, `@signal_…`, `@gmessages_…`, `@instagram_…`) and at most 50 joined members. In a
one-to-one chat the owner's messages count toward that partner; in a group they count toward nobody. Partners who left a room are
still counted from their messages. Phone numbers are filled in only for WhatsApp ids that look like numbers; Curia matches by
exact phone or email only.

## Test
`/usr/bin/python3 -m unittest discover -s jobs/contacts-export -p 'test_*.py'`
