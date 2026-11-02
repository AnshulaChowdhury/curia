# Local jobs: a one-command Mac mini installer and a "Local jobs" page in Curia

**Status:** DESIGN for review (not built). **Owner:** Anshula. **Reviewers:** web_dev (Books), contact_consolidation.
**Grounded in:** the Books runbook (`docs/mac-mini-setup.md` in the books repo), `ops/ventures.moonray.books-run.plist`,
`scripts/run-batch.sh`, `src/quickbooks/books-token.ts`, `docs/dev/books-quickbooks.md`, ADR-059/060.

## 1. Problem

Setting up the first local job (Books) took ten manual sections: create a macOS user, lock folders, make a deploy key, clone,
install dependencies, give the agent a Claude token, write token files by hand, install a LaunchDaemon, check it runs. Pasting
a command into a token file already went wrong once. A second job is coming (the contacts export: Matrix activity and Apple
Contacts), and a third will follow. Doing this by hand each time repeats the pain and the risk.

## 2. Goals and non-goals

Goals
- One command per job on the Mac mini, idempotent, that sets everything up and says exactly which step failed.
- A **Local jobs** page in Curia: generate the job's token, show the one command to run, then show live status.
- Same security shape as Books for every job, by default: outbound only, one macOS user per job, one scoped token per job.

Non-goals
- No remote execution of anything on the mini. Curia never connects in. No agent runs `sudo`.
- Not a general job platform. Jobs are small batch programs in git repos that talk to Curia over HTTPS.
- No change to how Books posts to QuickBooks (separate findings sent to web_dev).

## 3. Rules carried over from Books (the installer must not break these)

1. The mini only calls out to Curia. It accepts no inbound connections; the installer opens no ports.
2. Curia holds third-party credentials and state. The mini holds one Curia-issued token per job (stored in Curia only as a SHA-256).
3. A dedicated standard macOS user per job: no admin, no sudo, home and data folders `chmod 700`, FileVault stays on.
4. Read-only GitHub deploy key per job, owned by that job's user.
5. Secrets sit in `~/.<job>-env`, mode 600. Tokens are never pasted in chat; they are entered at a silent `read -rs` prompt.
6. All `sudo` steps are run by the owner. The installer prints what it will do before each `sudo` and waits.
7. The model step (when a job has one) starts with no tools: no files, no network.
8. Run reports carry names and counts only, never amounts, bank text or message content.

## 4. The pieces

### 4.1 Job manifest: `ops/job.yaml` in each job's repo

Declarative and small. The installer reads it; nothing else is hardcoded.

```yaml
id: contacts                 # lowercase letters/digits; becomes the macOS user, file and daemon names
label: Contacts export
repo: git@github.com:<owner>/<repo>.git
ref: v0.1.0                  # pinned tag; the installer verifies it, never "main"
macos_user: contacts
entry: scripts/run.sh        # the program the daemon runs
interval_seconds: 900        # LaunchDaemon StartInterval
install: ["/usr/bin/python3 -m pip install --user -r requirements.txt"]
secrets:                     # names only; values are entered at silent prompts
  - name: CONTACTS_API_TOKEN
    source: curia            # issued on the Local jobs page
  - name: MATRIX_ACCESS_TOKEN
    source: manual           # entered by the owner, never shown to an agent
  - name: CLAUDE_CODE_OAUTH_TOKEN
    source: claude-setup-token
    optional: true
curia:
  scopes: [contacts-import]  # what the Curia token can reach (see 4.3)
  heartbeat: true
check: "python3 -m contacts.check"   # a dry run that must exit 0
```

### 4.2 The installer: `ops/local-jobs/setup-local-job`

Run as the owner on the mini: `./setup-local-job <repo-or-manifest> [--dry-run]`. Every step is **check, do, verify**, so a
re-run only does what is missing.

| # | Step | Needs sudo | Notes |
|---|------|-----------|-------|
| 1 | Preflight | no | macOS version, FileVault on (warn, do not block), disk space, `git` and `python3` present |
| 2 | Create the user | yes | `sysadminctl -addUser`, password at its own prompt; standard user only |
| 3 | Folders | yes | `data/{inbox,state,out,logs}`, `chmod 700` on home and data |
| 4 | Deploy key | no | `ssh-keygen` as the job user; prints the **public** key; waits for the owner to add it in GitHub as read-only; tests `git ls-remote` |
| 5 | Clone and pin | no | clone, check out `ref`, print the commit and the manifest's SHA-256 for the owner to compare |
| 6 | Install dependencies | no | runs the manifest's `install` commands as the job user |
| 7 | Secrets | no | silent prompts, one per manifest secret (4.4); writes the 600 env file |
| 8 | Dry run | no | runs the manifest's `check`; must pass before a daemon exists |
| 9 | Daemon | yes | renders the plist from a template (user, interval, paths) into `/Library/LaunchDaemons/`, `launchctl bootstrap`, verifies state `waiting` |
| 10 | First heartbeat | no | waits up to 2 minutes for Curia to report the job alive (via the token); prints the Local jobs page link |

Companion commands: `setup-local-job doctor <id>` (re-verifies every step above and prints a pass/fail line each, no changes),
`setup-local-job rotate-token <id>` and `setup-local-job uninstall <id>` (bootout, remove plist; leaves data unless `--purge`).

What it never does: read or print a token, pass a secret on a command line or in an environment visible to `ps`, edit
`sudoers`, open a listener, run a model, or touch another job's user or files. `--dry-run` prints every command and exits.

### 4.3 Curia: the "Local jobs" page and registry

A new table `local_jobs` (id, label, token_hash, scopes, version, state, last_heartbeat_at, last_run_at, last_error_kind,
created_at). Settings > **Local jobs**, one card per job, in the order of the install:

1. **Make a token** (shown once, stored as a hash, replaces the old one; same pattern as `BooksToken`).
2. **Run this on the mini**: the exact command with the job id, a copy button, and the manifest hash to compare.
3. **Status**: *waiting for first heartbeat* / *running, last seen 2 min ago, v0.1.0* / *silent for 60 min* (red) / *last run failed:
   <kind>*. The red states say which installer step to re-run (for example "run `doctor contacts`").
4. **Revoke** and **Rotate** buttons.

Heartbeat and reports reuse Books' alert logic (missed deadline, failed run, file waiting, 60 minutes of silence) and its rule
that Curia, not the mini, raises alerts. Books keeps its own `/books/monitor` routes at first; a generic
`POST /local-jobs/heartbeat` serves new jobs, and Books can move onto it later.

**Token scopes are per job and per verb.** The Books review found that one token can both fetch approved batches and call
`POST /books/qbo/create`. For new jobs the registry stores scopes, and each route checks its scope, so a read token cannot
write and the contacts token reaches the contacts import and run-request routes only.

### 4.4 Entering secrets safely

The installer's prompt function, shared by every job, follows what `temp_logs` learned:
- `read -rs` (no echo), no value ever in `argv`, the environment of a child process, shell history, or a log.
- Rejects empty values, values containing whitespace or a newline, values shorter than 20 characters, and values that
  look like a command (`sudo`, `curl`, `export`, `=`-assignments, quotes). The earlier mistake pasted a command into a
  token file.
- Writes with `umask 077` to a temp file in the job's home, then renames to `~/.<id>-env`; re-reads only its length to confirm.
- A secret already present is kept unless the owner asks to replace it.

### 4.5 Run requests (for jobs Curia schedules)

Scheduling stays in Curia's scheduler. For a job that should run on a Curia schedule (the contacts export, Friday night):
Curia's scheduled job writes a run request (`run_id`, `since`); the daemon wakes every N minutes, calls
`GET /local-jobs/run-request`, and if one is open runs the job and closes it. A mini that was off simply picks the request up
when it returns. This needs no inbound connection and no Railway token in Curia.

### 4.6 Setup wizard integration

Each job gets an entry in `skills/setup/tools/setup-status/catalog.yaml` with a `completion_check` ("heartbeat within the last
hour") and a how-to pointing at the Local jobs page and the docs, per the repo rule that a new configurable capability ships
with its catalog entry.

## 5. Security notes

- **No `curl | sh`.** The installer comes from the repo at a pinned tag; the page shows its hash and the owner compares it.
- One token, one macOS user, one deploy key per job. Compromise of one job reaches nothing of another.
- The job's token is the only Curia credential on the mini. Third-party credentials stay in Curia, with one deliberate exception
  that needs the owner's explicit approval per job (the contacts job's Matrix access token, in its own user's 600 file).
- Tokens carry scopes; the check lives in Curia, not in the job's own code.
- Successful token use updates `last_used_at` (the Books review noted its absence), so a leak can be dated.
- The installer is idempotent and has `doctor`, so a half-finished setup is repairable without guessing.

## 6. Rollout

1. Manifest format and the installer, tried on the mini against **Books** with `--dry-run`, then for real (the Books daemon
   is not yet installed, so this doubles as its first install). web_dev reviews.
2. `local_jobs` table and the Local jobs page with status only (read-only), plus the generic heartbeat route.
3. Scoped tokens and run requests.
4. The **contacts** job as the second job (the exporter is designed separately).
5. Move Books' heartbeat onto the generic route.

## 7. Open questions

1. Where the installer lives: this repo (`ops/local-jobs/`) or a small separate one. It has to be pinned and reviewable.
2. Shell or Python for the installer. Shell matches `run-batch.sh`; Python makes the prompts and checks easier to test.
3. The power-cut case: FileVault waits for a password before the daemon can start. Accept and alert (as Books does), or discuss
   alternatives separately.
4. How strict the token format check should be before it blocks a legitimate token.
5. Whether `uninstall --purge` should exist at all, or deletion stays a manual step.

## 8. Not verified yet

- Behaviour of `sysadminctl -addUser`, `launchctl bootstrap` and `claude setup-token` on the mini's current macOS version.
- That the Books daemon, which has never been installed, works as the runbook describes.
- Which Railway or Curia pieces need changes to expose the generic heartbeat and run-request routes (small, but unmeasured).
