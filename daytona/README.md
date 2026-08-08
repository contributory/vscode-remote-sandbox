# Daytona Sandbox Tools — create sandboxes + keepalive

SDK-based tooling for [Daytona](https://www.daytona.io/docs) sandboxes. One
entry point — `sandbox.py` — creates (or reuses) a sandbox, provisions the
toolchain, starts the keepalive daemon, and prints how to connect.

| File              | What it does                                             | e2b equivalent |
| ----------------- | -------------------------------------------------------- | -------------- |
| `sandbox.py`      | Create/attach a sandbox, provision toolchain + keepalive, print connection info | `sandbox.js` + `template.js` |
| `keepalive.sh`    | In-sandbox daemon that bumps the activity timer while the sandbox is in use | `keepalive.sh` |
| `requirements.txt`| Python dependency (`daytona` SDK)                        | `package.json` |

> Unlike e2b, Daytona does **not** require a separate snapshot-build step: a
> sandbox can be created directly from an image (dynamic build) or from a
> default snapshot (which already includes Python + Node). So there is a single
> file instead of `template.py` + `sandbox.py`.

## Prerequisites

1. [Create an account](https://app.daytona.io/) and an [API key](https://app.daytona.io/dashboard/keys).
2. Export the key (the SDK also picks it up from a gitignored `.env`):

   ```sh
   export DAYTONA_API_KEY=dk_...
   ```

3. Install the SDK:

   ```sh
   cd daytona && python -m pip install -r requirements.txt
   ```

## 1. Create / attach a sandbox

```sh
python sandbox.py
```

Behavior:
- If `DAYTONA_SANDBOX_ID` is set, attach to that sandbox.
- Otherwise reuse the first existing usable sandbox (`started`/`stopped`/`paused`).
- Otherwise create a new one from `DAYTONA_BASE_IMAGE` (default `debian:stable-slim`;
  if Daytona rejects the floating tag, use `DAYTONA_BASE_IMAGE=debian:13-slim`).
- Starts it if needed, then **provisions** it on first run (cached by a marker
  file so it runs only once per sandbox) and launches the keepalive daemon
  **detached** (`setsid`, like the e2b daemon) so it outlives this process.
- Prints how to connect:

  ```
  SSH:          ssh <token>@ssh.app.daytona.io
  Web terminal: https://22222-<sandboxId>.proxy.daytona.work
  (CLI:         daytona ssh <sandboxId>)
  ```

First-run provisioning installs Docker (Docker-in-Docker), Node.js, git, curl,
tmux, etc. The **latest stable CPython** (default `3.14`, override
`DAYTONA_PYTHON_VERSION`) is installed via `uv` and symlinked to
`/usr/local/bin/{python3,python}`, so new shells get the newest Python instead
of the distro default. The distro `python3` remains installed as a fallback.

A **git identity** is also set in user space (`~/.gitconfig`, via
`git config --global user.name` / `user.email`) so commits from the sandbox are
attributed correctly. Defaults to `contributory <bosuutap@alwaysdata.net>`;
override with `GIT_USER_NAME` / `GIT_USER_EMAIL`. The same defaults/overrides
apply to the `e2b` and `modal` setups.

To run Docker inside the sandbox (it's Docker-in-Docker, so the daemon isn't
running after a fresh start):

```sh
sudo dockerd &   # once per session, or add to your shell profile
```

## 2. Keepalive mechanism

Daytona **auto-stops a running sandbox after 15 minutes of inactivity** by
default. The inactivity timer is reset only by:

- interactive SDK/Toolbox calls,
- **active SSH connections**,
- network requests to sandbox previews.

It is **not** reset by background scripts or long-running tasks. The
`daytona-keepalive` daemon closes that gap. Every `DAYTONA_KEEPALIVE_INTERVAL`
(60s) seconds it calls the platform REST API:

```sh
POST https://app.daytona.io/api/sandbox/<sandboxId>/last-activity
     Authorization: Bearer $DAYTONA_API_KEY
```

— the same endpoint as the SDK's `sandbox.refresh_activity()` — which resets
the inactivity timer. When it stops signalling, the auto-stop interval takes
over and cost drops back to ~0.

### Modes (`DAYTONA_KEEPALIVE_MODE`, default `ssh`)

| Mode      | Keeps alive while...                                            | Use for                      |
| --------- | --------------------------------------------------------------- | ---------------------------- |
| `ssh`     | a live SSH session is detected (TCP :22 / sshd process)         | interactive SSH / VS Code    |
| `always`  | always (every interval, unconditionally)                        | long background jobs         |
| marker    | a marker file exists (`DAYTONA_KEEPALIVE_MARKER=/tmp/job`)      | precise job-scoped keepalive |

Example — hold a long training job alive, then release it:

```sh
# inside the sandbox:
touch /tmp/job && python train.py; rm -f /tmp/job  # sandbox releases after 15min idle
```

You can also push the **wall-clock TTL** (destroy deadline) forward on every
bump by setting `DAYTONA_TTL_MINUTES` (e.g. `60`), which is useful for sandboxes
created with a hard `ttlMinutes` limit.

### Safety / design notes

- `flock`-guarded so re-running `sandbox.py` can't stack up duplicate loops.
- Launched with `setsid </dev/null >log 2>&1 &` so it survives the SDK
  connection and keeps running for the sandbox's lifetime.
- Only needs `curl`; no SDK inside the sandbox.
- Since Daytona's native SSH already resets the timer, `ssh` mode is a safety
  net; use `always`/marker mode for anything the platform wouldn't count as
  activity.

## Lifecycle / cleanup

- **Stop** (frees CPU, keeps filesystem): `daytona stop <sandboxId>` or via the
  dashboard. Stopped sandboxes auto-archive after 7 days by default.
- **Delete**: `daytona delete <sandboxId>` or the dashboard.
- Tune per-sandbox with `auto_stop_interval`, `auto_pause_interval` (VM only),
  `auto_delete_interval`, and `ttl_minutes` in `sandbox.py`.

See the [Daytona docs](https://www.daytona.io/docs) for the full API.
