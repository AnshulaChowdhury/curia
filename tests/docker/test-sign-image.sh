#!/usr/bin/env bash
# Tests for docker/sign-image.sh (curia#2369).
#
# Twice on 2026-10-29 the publish went red after a good push because cosign's
# Rekor upload stalled, landed anyway, and cosign's own retry got a 409:
#
#   [POST /api/v1/log/entries][409] createLogEntryConflict
#   "an equivalent entry already exists in the transparency log"
#
# A stub `cosign` on PATH forces that failure so the second attempt is observed,
# not assumed.
#
# Run: bash tests/docker/test-sign-image.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIGN="$REPO_ROOT/docker/sign-image.sh"

pass=0
fail=0
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

check_eq() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

IMAGE="ghcr.io/example/curia"
DIGEST="sha256:1e58e43e4bd9b3cbba8f8a06035d3a0f0fdb0400073bfc071bb6f02f348e9793"

INCIDENT_LOG='Error: signing [ghcr.io/example/curia@sha256:1e58e43e4bd9b3cbba8f8a06035d3a0f0fdb0400073bfc071bb6f02f348e9793]: signing digest: signing bundle: error signing bundle: [POST /api/v1/log/entries][409] createLogEntryConflict {"code":409,"message":"an equivalent entry already exists in the transparency log with UUID 108e9186e8c5677aeb1f094c6fe56f3a22389992ad5dec406fbb8eee9f7cf965b77a330b43956968"}'

# A cosign stub on PATH. The first `fail_times` invocations print `fail_log`
# and exit `fail_status`; later ones succeed. Every argv element is recorded,
# one per line.
install_cosign_stub() { # dir fail_times fail_status fail_log
  mkdir -p "$1/bin"
  printf '%s\n' "$2" > "$1/fail_times"
  printf '%s\n' "$4" > "$1/fail_log"
  cat > "$1/bin/cosign" <<STUB
#!/usr/bin/env bash
dir="$1"
n=\$(( \$(cat "\$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$dir/count"
printf '%s\n' "\$@" > "\$dir/args"
if [ "\$n" -le "\$(cat "\$dir/fail_times")" ]; then
  cat "\$dir/fail_log" >&2
  exit $3
fi
echo "stub: signed on attempt \$n"
exit 0
STUB
  chmod +x "$1/bin/cosign"
}

echo "docker/sign-image.sh"

[ -f "$SIGN" ] || { echo "  FAIL script not found at $SIGN"; exit 1; }
[ -x "$SIGN" ] || bad "script is not executable"

# 1. Success is one attempt, signing by digest.
d="$tmpdir/t1"; install_cosign_stub "$d" 0 1 ""
PATH="$d/bin:$PATH" IMAGE="$IMAGE" DIGEST="$DIGEST" SIGN_RETRY_DELAY=0 "$SIGN" >/dev/null 2>&1
check_eq "succeeds first try" "0" "$?"
check_eq "  ...runs cosign once" "1" "$(cat "$d/count")"
check_eq "  ...signs the image by digest" "$(printf '%s\n' sign --yes "$IMAGE@$DIGEST")" "$(cat "$d/args")"

# 2. The Rekor 409 is retried, and the second attempt is visible.
d="$tmpdir/t2"; install_cosign_stub "$d" 1 1 "$INCIDENT_LOG"
out=$(PATH="$d/bin:$PATH" IMAGE="$IMAGE" DIGEST="$DIGEST" SIGN_RETRY_DELAY=0 "$SIGN" 2>&1)
check_eq "Rekor 409 is retried and then succeeds" "0" "$?"
check_eq "  ...second attempt actually ran" "2" "$(cat "$d/count")"
case "$out" in
  *"retrying with fresh keys in 0s"*) ok "  ...and the log shows the retry, not a silent second run" ;;
  *) bad "  ...but the retry was not announced ($(printf '%s' "$out" | tr '\n' ' '))" ;;
esac
case "$out" in
  *"createLogEntryConflict"*) ok "  ...and cosign's own error stays in the log" ;;
  *) bad "  ...but cosign's error was swallowed" ;;
esac

# 3. A sustained failure spends the budget, then preserves cosign's exit code.
d="$tmpdir/t3"; install_cosign_stub "$d" 9 7 "$INCIDENT_LOG"
out=$(PATH="$d/bin:$PATH" IMAGE="$IMAGE" DIGEST="$DIGEST" SIGN_RETRY_DELAY=0 SIGN_RETRY_ATTEMPTS=3 "$SIGN" 2>&1)
check_eq "exhausted budget preserves cosign's exit code" "7" "$?"
check_eq "  ...after exactly 3 attempts" "3" "$(cat "$d/count")"
case "$out" in
  *"the image IS pushed"*) ok "  ...and says the image itself was published" ;;
  *) bad "  ...but did not say the image was pushed" ;;
esac

# 4. Delay backs off linearly, and a zero-prefixed knob is decimal. `sleep` is
#    shadowed so the computed values are observable.
d="$tmpdir/t4"; install_cosign_stub "$d" 9 1 "$INCIDENT_LOG"
printf '#!/bin/sh\necho "SLEPT:$1" >&2\n' > "$d/bin/sleep"; chmod +x "$d/bin/sleep"
out=$(PATH="$d/bin:$PATH" IMAGE="$IMAGE" DIGEST="$DIGEST" SIGN_RETRY_DELAY=010 SIGN_RETRY_ATTEMPTS=3 "$SIGN" 2>&1)
case "$out" in
  *"SLEPT:10"*"SLEPT:20"*) ok "waits 10s then 20s (decimal, linear)" ;;
  *) bad "unexpected waits ($(printf '%s' "$out" | grep SLEPT | tr '\n' ' '))" ;;
esac

# 5. Missing or malformed inputs fail before cosign runs.
d="$tmpdir/t5"; install_cosign_stub "$d" 0 1 ""
PATH="$d/bin:$PATH" IMAGE="$IMAGE" DIGEST="" SIGN_RETRY_DELAY=0 "$SIGN" >/dev/null 2>&1
check_eq "empty DIGEST is rejected" "1" "$?"
PATH="$d/bin:$PATH" IMAGE="$IMAGE" DIGEST="edge" SIGN_RETRY_DELAY=0 "$SIGN" >/dev/null 2>&1
check_eq "a tag in place of a digest exits 2" "2" "$?"
PATH="$d/bin:$PATH" DIGEST="$DIGEST" SIGN_RETRY_DELAY=0 "$SIGN" >/dev/null 2>&1
check_eq "missing IMAGE is rejected" "1" "$?"
PATH="$d/bin:$PATH" IMAGE="$IMAGE" DIGEST="$DIGEST" SIGN_RETRY_ATTEMPTS=abc "$SIGN" >/dev/null 2>&1
check_eq "non-numeric SIGN_RETRY_ATTEMPTS exits 2" "2" "$?"
PATH="$d/bin:$PATH" IMAGE="$IMAGE" DIGEST="$DIGEST" SIGN_RETRY_ATTEMPTS=0 "$SIGN" >/dev/null 2>&1
check_eq "zero SIGN_RETRY_ATTEMPTS exits 2" "2" "$?"
if [ ! -f "$d/count" ]; then ok "  ...none of them ran cosign"; else bad "  ...but cosign ran"; fi

echo
echo "sign-image: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
