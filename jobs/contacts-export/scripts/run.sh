#!/bin/sh
# One pass of the contacts export. Run by launchd as /bin/sh; the env file is already loaded by the daemon wrapper.
# An atomic mkdir lock stops overlapping runs; a lock older than 2 hours is treated as stale.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="${HOME}/data/state/run.lock"
mkdir -p "${HOME}/data/state"
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; fi
mkdir "$LOCK" 2>/dev/null || { echo "another run is in progress"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
cd "$HERE" || exit 1
/usr/bin/python3 -m contacts_export.run
