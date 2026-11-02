# Books deadline, heartbeat and alerts

Curia watches the weekly books run so a missed file, a failed run or a silent Mac mini is noticed even when the Mac mini itself is down (FR-INT-5, FR-INT-7, FR-INT-8).

## What the Mac mini sends (books token)

- `POST /books/heartbeat` `{at?, version?, state?: 'idle'|'running'|'deferred', last_run_at?}` every 15 minutes. The check-in time is Curia's own clock, not `at`.
- `POST /books/runs` `{report: {status: 'ready'|'failed'|'deferred', batch_id?, ...}, accounts_received: string[], expected_accounts: string[], files: string[]}` after every run. The report is stored as data (≤ 256 KB). A `failed` report notifies the reviewers at once.

## What Curia checks (every 15 minutes, `BooksMonitor`)

| Check | Fires when | Repeats |
|---|---|---|
| Reminder | the reminder job's latest fire time passed (default Monday 08:00 Toronto) and not everything has arrived | once per fire |
| Deadline | the deadline job's latest fire time passed (default Tuesday 12:00 Toronto) and an expected account has no file since that week's Monday 00:00 | daily until it arrives |
| Unprocessed file | a bank file has sat in the Drive folder > 60 min with no run report since it arrived | daily |
| Silent Mac mini | no heartbeat for 60 min (only after a first heartbeat) | daily |
| Failed run | the run report says `failed` | immediately |

A `deferred` run (usage limit) is never a missed deadline and silences the deadline, unprocessed-file and silent checks. Messages name accounts, weeks and the check only: never amounts, bank text or file contents.

## Timing lives in the scheduler (FR-INT-8)

The first time the books token exists, the monitor creates two ordinary scheduler jobs (created by `books`, once: it records `jobs_seeded` and never recreates them, even if you delete them):

- reminder: `0 8 * * 1`, America/Toronto
- deadline: `0 12 * * 2`, America/Toronto

Change a time, pause or resume them with `scheduler-update` like any job. The monitor reads each job's `cron_expr`, timezone and status (a paused or cancelled job switches its check off) and sends the notification itself within one 15-minute tick of the fire time. The scheduler can only run a job through a registered agent, so when a row fires the coordinator runs a harmless checkpoint task ("handled by the books monitor"); it does not notify anyone.

The 15-minute health check is a system timer, not a scheduler job (an agent run every 15 minutes would cost tokens for nothing). Its interval is a code constant.

## Who is told

Settings → API connections → **Books: deadlines and alerts** lists the reviewers (name, email, ntfy topic), stored in the vault as `books_reviewers`. A push goes to each reviewer's ntfy topic: a bare topic name uses the ntfy server set up for inbox triage (`inbox_triage_ntfy_url`, `inbox_triage_ntfy_token`), or give a full https address. The same card shows heartbeat age, the last run, this week's received/missing accounts and the job times (`GET /api/books/status`).

**Email is not sent yet.** The repo's email path goes through the outbound gateway, which needs an agent/skill context a plain service does not have. Adding it is a follow-up; ntfy covers the push requirement.
