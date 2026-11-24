#!/bin/sh
# Image entrypoint. Optionally runs a signal-cli JSON-RPC daemon beside Curia, then execs the real command.
#
# Why: Curia's Signal channel reaches signal-cli over a Unix socket (src/channels/signal/signal-rpc-client.ts),
# so the daemon has to share a filesystem with Curia. On hosts where each service is its own container (Railway),
# that means running it inside this container.
#
# Opt-in: with SIGNAL_CLI_DAEMON unset (the default) this script does nothing but `exec "$@"`, so the image
# behaves exactly as before.
#
# Multi-account mode: the daemon is started without `-a`, so it serves every number registered under the config
# directory. Curia sends the account number with each RPC call, so no number is configured here.
#
# Env:
#   SIGNAL_CLI_DAEMON      "true" to start the daemon. Anything else leaves it off.
#   SIGNAL_CLI_CONFIG_DIR  signal-cli data dir, holds the account keys. Default /data/signal-cli. Put a volume here;
#                          if it is lost the number has to be registered again.
#   SIGNAL_CLI_SOCKET      Unix socket path. Default /run/signal-cli/socket. Enter the same path in the console as
#                          Settings -> Channels -> Signal -> signal-cli socket path.
#
# Privileges: the container now starts as root (the Dockerfile no longer sets USER) so this script can hand a freshly
# mounted, root-owned volume to the curia user. Everything that does real work - the signal-cli daemon and Curia itself -
# is started as curia (uid/gid 1001) through setpriv. If the container is started as a non-root user (docker run --user,
# compose `user:`), nothing is chowned and nothing is dropped; it just runs as that user.
set -eu

CURIA_UID=1001
CURIA_GID=1001

if [ "$(id -u)" = "0" ]; then
  run_as() { exec setpriv --reuid="$CURIA_UID" --regid="$CURIA_GID" --clear-groups "$@"; }
  bg_as() { setpriv --reuid="$CURIA_UID" --regid="$CURIA_GID" --clear-groups "$@"; }
else
  run_as() { exec "$@"; }
  bg_as() { "$@"; }
fi

# Create the data and socket dirs and make sure curia can write to them. As root this also fixes a volume that was
# mounted root-owned. Only the two directories are touched, never anything else.
prepare_dirs() {
  mkdir -p "$config_dir" "$(dirname "$socket")" 2>/dev/null || return 1
  if [ "$(id -u)" = "0" ]; then
    chown -R "$CURIA_UID:$CURIA_GID" "$config_dir" "$(dirname "$socket")" 2>/dev/null || return 1
    chmod 700 "$config_dir" 2>/dev/null || true
    return 0
  fi
  [ -w "$config_dir" ]
}

if [ "${SIGNAL_CLI_DAEMON:-}" = "true" ]; then
  config_dir="${SIGNAL_CLI_CONFIG_DIR:-/data/signal-cli}"
  socket="${SIGNAL_CLI_SOCKET:-/run/signal-cli/socket}"

  if ! command -v signal-cli >/dev/null 2>&1; then
    # The binary is only installed for linux/amd64 builds. Say so loudly, then carry on: Curia must still start.
    echo "signal-cli-entrypoint: SIGNAL_CLI_DAEMON=true but signal-cli is not installed in this image (linux/amd64 only); starting Curia without it" >&2
  elif ! prepare_dirs; then
    echo "signal-cli-entrypoint: cannot write to $config_dir (check the volume's ownership); starting Curia without signal-cli" >&2
  else
    # Restart loop: signal-cli exiting must not take Curia down, and nothing else would bring it back.
    (
      while true; do
        rm -f "$socket"
        echo "signal-cli-entrypoint: starting signal-cli daemon (socket $socket)" >&2
        bg_as signal-cli --config "$config_dir" daemon --socket "$socket" --receive-mode on-start || true
        echo "signal-cli-entrypoint: signal-cli exited; restarting in 5s" >&2
        sleep 5
      done
    ) &
  fi
fi

run_as "$@"
