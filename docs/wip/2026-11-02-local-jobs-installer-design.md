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

### 4.1 Job manifest: `ops/job.json` in each job's repo

Declarative and small. **JSON, not YAML**: a fresh mini has only Apple's `/usr/bin/python3` 3.9.6, with no PyYAML and no
`tomllib`, so the installer must read its own manifest with the standard library (`json`) or `plutil` before any `pip` has run.
The installer reads the manifest; nothing else about a job is hardcoded.

```json
{
  "id": "contacts",
  "label": "Contacts export",
  "repo": "git@github.com:<owner>/<repo>.git",
  "ref": "v0.1.0",
  "macos_user": "contacts",
  "entry": "scripts/run.sh",
  "interval_seconds": 60,
  "install": ["/usr/bin/python3 -m pip install --user -r requirements.txt"],
  "import_check": ["requests"],
  "test": "/usr/bin/python3 -m pytest -q",
  "secrets": [
    { "name": "CONTACTS_API_TOKEN", "source": "curia" },
    { "name": "MATRIX_ACCESS_TOKEN", "source": "manual" },
    { "name": "CLAUDE_CODE_OAUTH_TOKEN", "source": "claude-setup-token", "optional": true }
  ],
  "curia": { "scopes": ["contacts-import"], "heartbeat": true },
  "check": "/usr/bin/python3 -m contacts.check"
}
```
`ref` is a pinned tag, never `main`. `entry` is **always run as `/bin/sh <entry>`** (by the installer, `doctor` and the plist),
never through its exec bit: Books' `run-batch.sh` was mode 644 in git, `sudo -u books .../run-batch.sh` said "command not found",
and a plist that executed it directly would never have started. `check` must make a real call to Curia with the job's token
(Books' `qbo_status.py`, which prints the company name, is the model), not only import the code.

### 4.2 The installer: `ops/local-jobs/setup-local-job`

Run as the owner on the mini: `./setup-local-job <repo-or-manifest> [--dry-run]`. Every step is **check, do, verify**, so a
re-run only does what is missing.

| # | Step | Needs sudo | Notes |
|---|------|-----------|-------|
| 1 | Preflight | no | macOS version, FileVault on (warn, do not block), disk space, `git` and `python3` present |
| 2 | Create the user | yes | `sysadminctl -addUser <id> -fullName <label> -password - -home /Users/<id>` (the `-` is its own argument; `-password --home` fails with a usage error). It prints "Home directory is assigned (not created!)", so also run `sudo createhomedir -c -u <id>` and `chmod 700`. Never pass `-admin`. The "will not allow user to use FDE" warning is expected |
| 3 | Folders | yes | `data/{inbox,state,out,logs}`, `chmod 700` on home and data |
| 4 | Deploy key | no | `ssh-keygen` as the job user; prints the **public** key; waits for the owner to add it in GitHub as read-only; tests `git ls-remote` |
| 5 | Clone and pin | no | clone, check out `ref`, print the commit and the manifest's SHA-256 for the owner to compare |
| 6 | Install dependencies | no | runs the manifest's `install` commands as the job user, then **verifies by importing** each `import_check` package and **runs the repo's tests as the job user**. (pip once silently did not run and nothing noticed until 17 tests failed at import.) Apple's python is 3.9.6 with pip 21 |
| 7 | Secrets | no | silent prompts, one per manifest secret (4.4); writes the 600 env file |
| 8 | Dry run | no | runs the manifest's `check`, an end-to-end call to Curia with the job's token; must pass before a daemon exists. If the job has a Claude token, verifies it as the job user with only that file loaded: `claude -p "Reply with the single word: ok"` ("Not logged in" means the token or file is wrong) |
| 9 | Daemon | yes | renders the plist (owner `root:wheel`, mode 644, `UserName` = the job user, `ProgramArguments` = `/bin/sh` + the entry) into `/Library/LaunchDaemons/`; `launchctl bootstrap`. `RunAtLoad` runs it at once, so verify by **reading the job's log**, not only `launchctl print`. **Detects an existing daemon with the same label and is idempotent**, so it can adopt Books' hand-installed one. The entry keeps an atomic `mkdir` lock so runs cannot overlap (cleared after 2 hours). Logs are monthly files plus `launchd.out/err`; nothing rotates the launchd ones |
| 10 | First heartbeat | no | waits up to 2 minutes for Curia to report the job alive (via the token); prints the Local jobs page link |

Companion commands: `setup-local-job doctor <id>` (re-verifies every step above and prints a pass/fail line each, no changes),
`setup-local-job rotate-token <id>` and `setup-local-job uninstall <id>` (bootout, remove plist; leaves data unless `--purge`).

Mechanics learned from Books by hand:
- The installer is **bash run from a file**, never pasted lines (zsh does not word-split a command held in a variable, and a pasted multi-line command once lost its closing quote).
- `sudo -u <user>` keeps the caller's working directory, which the job user cannot read: each sudo'd shell starts with `cd` to the job's home and uses absolute paths.
- `doctor` also **runs the entry as the job user** (as `/bin/sh <entry>`), checks the plist's owner and mode, and checks the env file's mode.

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
- `read -rs` (no echo). The value goes by **stdin**, never `argv` (the first Books version put it in `$0`, briefly visible in `ps`), the
  environment of a child process, shell history, or a log.
- After the silent prompt it prints **"received N characters"**. With no echo the prompt looked broken, and the count is what caught a
  truncated or wrong paste. Real lengths seen: Claude `setup-token` 108, Curia books token 64.
- Rejects empty values, any whitespace or newline, values shorter than 20 characters, and anything outside a token charset
  (`[A-Za-z0-9._~+/=-]`) or that looks like a command. **No upper length cap.**
- **The env file is sourced by the shell**, so a bad value is not just wrong, it runs. Books once got `VAR=sudo ls -l ...` in the
  file and sourcing it ran `ls`. So values are written **single-quoted**, and where possible the file is parsed without being executed.
- Writes with `umask 077` to a temp file in the job's home, then renames to `~/.<id>-env`; confirms only its length.
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

- **The Mac mini is the machine the owner works on** (the owner's own login, the T7 volume and the Curia checkouts are all on it). So a job's user is
  separated from the owner's login on the same machine, not from a dedicated box. The isolation boundary is macOS user permissions alone
  (home `700`, env file `600`, no admin), and the owner's own account has admin rights. State this plainly in the Local jobs page. Confirm with the owner.

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

## 7. Decisions (from web_dev's review, 2026-11-02; owner to confirm)

1. **Where:** the installer lives in this repo at a pinned tag (`ops/local-jobs/`).
2. **Shell or Python:** bash from a file, with a **JSON** manifest (section 4.1). No YAML on a fresh mini.
3. **Power cut:** accept it. Daemons start at boot but only after FileVault is unlocked; Curia's 60-minute silence alert is the remedy.
4. **Token strictness:** reject empty, whitespace, newline and command-like values; floor of 20 characters; no upper cap.
5. **`uninstall --purge`:** does not exist. Deleting a job's data stays a manual step.

Still open
- Whether the owner is comfortable with job users sharing the machine with their own admin login (section 5).
- Whether Books' hand-installed daemon (label `ventures.moonray.books-run`, 60 s interval) is adopted by the installer or left alone.

## 8. Not verified yet

- Behaviour of `sysadminctl`, `createhomedir`, `launchctl bootstrap` and `claude setup-token` on the mini's current macOS (web_dev has
  run the first three by hand and the notes above come from that).
- **The daemon path.** The Books pipeline itself now works end to end on the mini (first real run: 2 files fetched, 35 transactions pushed
  for review, report accepted by Curia), but it has never run under launchd. web_dev plans to install the Books daemon by hand this
  week; the installer must then detect it and be idempotent.
- Which Curia pieces the generic heartbeat and run-request routes need (small, but unmeasured).
