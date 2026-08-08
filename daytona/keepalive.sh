#!/bin/sh
# daytona-keepalive — keep a Daytona sandbox alive while it is in use.
#
# Why this exists:
#   By default Daytona auto-stops a running sandbox after 15 minutes of
#   inactivity. The inactivity timer is reset by interactive Toolbox/SDK calls
#   and by active SSH connections, but NOT by background scripts or long-running
#   tasks. This daemon periodically signals the platform
#   (POST /api/sandbox/{id}/last-activity) so the sandbox stays up while it is
#   actually being used, and stops signalling when it goes idle so the
#   auto-stop interval can kick in and cost drops back to ~0.
#
#   It is installed by sandbox.py during first-run provisioning and launched
#   from there as a detached background process (setsid), so it survives the
#   SDK connection. It uses only curl + the REST API, so nothing depends on the
#   daytona SDK being installed inside the sandbox.
#
# Env:
#   DAYTONA_API_KEY            (required) platform API key (Authorization: Bearer).
#   DAYTONA_SANDBOX_ID         (required) target sandbox id.
#   DAYTONA_API_URL            (optional, default https://app.daytona.io/api)
#   DAYTONA_KEEPALIVE_INTERVAL (optional, default 60)  seconds between bumps.
#   DAYTONA_KEEPALIVE_MODE     (optional, default ssh)
#       ssh    - bump only while a live SSH session is detected.
#       always - bump every interval, unconditionally (long background jobs).
#   DAYTONA_KEEPALIVE_MARKER   (optional) path to a marker file; while it exists
#                              the sandbox is kept alive regardless of mode.
#                              Remove the file when the job finishes.
#   DAYTONA_TTL_MINUTES        (optional) if set, also push the wall-clock TTL
#                              (destroy deadline) this far into the future on
#                              each bump.

set -eu

API_URL="${DAYTONA_API_URL:-https://app.daytona.io/api}"
INTERVAL="${DAYTONA_KEEPALIVE_INTERVAL:-60}"
MODE="${DAYTONA_KEEPALIVE_MODE:-ssh}"
MARKER="${DAYTONA_KEEPALIVE_MARKER:-}"
TTL_MINUTES="${DAYTONA_TTL_MINUTES:-}"
SANDBOX_ID="${DAYTONA_SANDBOX_ID:-}"

# Single-instance guard so a reconnect (which re-launches this) can't stack up
# multiple loops. The first instance holds the lock for its whole lifetime;
# later ones fail the non-blocking flock and exit quietly.
if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/daytona-keepalive.lock
  flock -n 9 || exit 0
fi

if [ -z "${DAYTONA_API_KEY:-}" ] || [ -z "$SANDBOX_ID" ]; then
  echo "daytona-keepalive: DAYTONA_API_KEY and DAYTONA_SANDBOX_ID are required" >&2
  exit 1
fi

log() { echo "daytona-keepalive: $*" >&2; }

# A live SSH session is an established connection to the sandbox SSH port,
# with a fallback to sshd-style process names for other/older setups.
has_live_session() {
  if command -v ss >/dev/null 2>&1; then
    ss -Htn state established '( sport = :22 or dport = :22 )' 2>/dev/null | grep -q . && return 0
  fi
  pgrep -f 'sshd.*@' >/dev/null 2>&1 && return 0
  return 1
}

keepalive() {
  [ "$MODE" = "always" ] && return 0
  [ -n "$MARKER" ] && [ -f "$MARKER" ] && return 0
  [ "$MODE" = "ssh" ] && has_live_session && return 0
  return 1
}

bump() {
  # Reset the inactivity timer (REST equivalent of sandbox.refresh_activity()).
  curl -fsS -X POST "$API_URL/sandbox/$SANDBOX_ID/last-activity" \
    -H "Authorization: Bearer $DAYTONA_API_KEY" >/dev/null 2>&1 || true
  # Optionally extend the wall-clock TTL (destroy deadline) too.
  if [ -n "$TTL_MINUTES" ]; then
    curl -fsS -X POST "$API_URL/sandbox/$SANDBOX_ID/ttl/$TTL_MINUTES" \
      -H "Authorization: Bearer $DAYTONA_API_KEY" >/dev/null 2>&1 || true
  fi
}

log "started (mode=$MODE interval=${INTERVAL}s sandbox=$SANDBOX_ID)"
while :; do
  sleep "$INTERVAL"
  if keepalive; then
    bump
  fi
done
