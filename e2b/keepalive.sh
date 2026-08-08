#!/bin/sh
# e2b-keepalive — keep an E2B sandbox alive only while someone is SSH'd in.
#
# Why this exists:
#   SSH reaches this sandbox through the websocat port-forward on :8081. That
#   forwarded traffic does NOT reset the sandbox TTL, so a plain SSH/VSCode
#   session would get paused (onTimeout: pause) out from under you mid-work.
#   This daemon detects live SSH sessions and, while at least one is open,
#   repeatedly bumps the TTL via the E2B REST API
#   (POST /sandboxes/{id}/timeout). When nobody is connected it stops bumping,
#   so the sandbox pauses on its own and cost drops to ~0; reconnecting
#   auto-resumes it.
#
#   It is started from the SDK (sandbox.js) as a background command, NOT from
#   the template start command: env vars passed at Sandbox.create() time (like
#   E2B_API_KEY) are invisible to the build-time start command, but they ARE
#   visible to SDK-launched commands. It also uses only curl + the REST API, so
#   nothing depends on the e2b SDK being installed inside the sandbox.
#
# Env:
#   E2B_API_KEY            (required) platform API key, sent as X-API-Key.
#   E2B_SANDBOX_ID         (required) target sandbox id.
#   E2B_TTL_SECONDS        (optional, default 300) TTL to set on each bump.
#   E2B_KEEPALIVE_INTERVAL (optional, default 60)  seconds between checks.
#   E2B_API_BASE           (optional, default https://api.e2b.app).

set -eu

TTL_SECONDS="${E2B_TTL_SECONDS:-300}"
INTERVAL="${E2B_KEEPALIVE_INTERVAL:-60}"
API_BASE="${E2B_API_BASE:-https://api.e2b.app}"
SANDBOX_ID="${E2B_SANDBOX_ID:-}"

# Single-instance guard so reconnecting (which re-launches this) can't stack up
# multiple loops. The first instance holds the lock for its whole lifetime;
# later ones fail the non-blocking flock and exit quietly.
if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/e2b-keepalive.lock
  flock -n 9 || exit 0
fi

if [ -z "${E2B_API_KEY:-}" ] || [ -z "$SANDBOX_ID" ]; then
  echo "e2b-keepalive: E2B_API_KEY and E2B_SANDBOX_ID are required" >&2
  exit 1
fi

while :; do
  sleep "$INTERVAL"

  # A live session is a per-connection process titled "<user>@<tty>", e.g.
  # "sshd-session: user@pts/0" or "...: user@notty". OpenSSH <9.8 uses
  # "sshd: user@..."; >=9.8 (Ubuntu 25.04 ships 9.9) split it into a separate
  # "sshd-session" binary. Match both. The trailing "@" excludes the master
  # listener ("sshd: ... [listener]"), which never contains one.
  pgrep -f 'sshd(-session)?:.*@' >/dev/null 2>&1 || continue

  # Bump the TTL. Overwrites the previous TTL, measured from now.
  curl -fsS -X POST "$API_BASE/sandboxes/$SANDBOX_ID/timeout" \
    -H "X-API-Key: $E2B_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"timeout\": $TTL_SECONDS}" >/dev/null 2>&1 || true
done
