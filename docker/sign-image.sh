#!/usr/bin/env bash
# Keyless-sign a pushed image by digest, retrying a failed attempt (curia#2369).
#
# The incident (runs 40869199649 and 40946295794, both 2026-10-29):
#
#   Signing artifact...                      <- ~30s stall
#   Error: signing [ghcr.io/.../curia@sha256:...]: ... [POST /api/v1/log/entries][409]
#   createLogEntryConflict "an equivalent entry already exists in the transparency log"
#
# Cosign's upload to Rekor stalled, timed out client-side and landed anyway, so
# cosign's own retry of that same upload got a 409 and gave up. The image was
# pushed; only its signature was missing, and the publish went red.
#
# A fresh `cosign sign` cannot hit that conflict: every invocation generates
# new ephemeral keys and gets a new Fulcio certificate, so its Rekor entry is
# new. A retry of the whole command is what recovers. The cost is an extra,
# harmless entry in the public log for the attempt that half-succeeded.
#
# Unlike buildx-retry.sh this retries every non-zero exit, not a classified
# signature. That script classifies because a wasted retry there is a full
# multi-arch rebuild. Here it is one more signing call, so a permanent failure
# (say, a lost `id-token: write`) costs seconds, and matching Sigstore's error
# text would only miss the next transient it phrases differently.
#
# Runs on the GitHub-hosted runner (bash). Do not COPY this into an image.
#
# Env:    IMAGE                 required  registry/owner/name, no tag
#         DIGEST                required  sha256:... from publish-image.sh
#         SIGN_RETRY_ATTEMPTS   (default 3)  total attempts, not extra retries
#         SIGN_RETRY_DELAY      (default 10) base seconds; backs off linearly
# The two knobs exist so tests can run fast. The workflow uses the defaults.
set -euo pipefail

: "${IMAGE:?IMAGE is required}"
: "${DIGEST:?DIGEST is required}"

attempts="${SIGN_RETRY_ATTEMPTS:-3}"
base_delay="${SIGN_RETRY_DELAY:-10}"

# Same knob rules as buildx-retry.sh: a non-numeric value must not fall into
# `set -e` arithmetic and replace cosign's exit code, and a leading zero must
# not become octal.
case "$attempts" in
  ''|*[!0-9]*) echo "sign-image: SIGN_RETRY_ATTEMPTS must be a positive integer (got '$attempts')" >&2; exit 2 ;;
esac
[ "$attempts" -ge 1 ] || { echo "sign-image: SIGN_RETRY_ATTEMPTS must be >= 1 (got '$attempts')" >&2; exit 2; }
case "$base_delay" in
  ''|*[!0-9]*) echo "sign-image: SIGN_RETRY_DELAY must be a non-negative integer (got '$base_delay')" >&2; exit 2 ;;
esac
while :; do
  case "$base_delay" in
    0[0-9]*) base_delay="${base_delay#0}" ;;
    *) break ;;
  esac
done

# Signing a tag would sign whatever the tag points at by the time cosign
# resolves it, which a concurrent publish may have moved.
case "$DIGEST" in
  sha256:*) ;;
  *) echo "sign-image: DIGEST must be a sha256 digest (got '$DIGEST')" >&2; exit 2 ;;
esac

attempt=1
while :; do
  set +e
  cosign sign --yes "${IMAGE}@${DIGEST}"
  status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "sign-image: giving up after ${attempts} attempt(s) (exit ${status}); the image IS pushed, only its signature is missing" >&2
    exit "$status"
  fi

  delay=$((base_delay * attempt))
  echo "sign-image: attempt ${attempt}/${attempts} failed (exit ${status}); retrying with fresh keys in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
