#!/usr/bin/env python3
"""sandbox.py — create/attach a Daytona sandbox, provision the toolchain,
start the keepalive daemon, and print how to connect.

This is the single entry point: Daytona creates sandboxes directly from an
image (dynamic build), so there is no separate snapshot-build step needed.

    export DAYTONA_API_KEY=dk_...
    python sandbox.py                               # create/attach + keepalive
    DAYTONA_SANDBOX_ID=<id> python sandbox.py       # attach a specific sandbox
    DAYTONA_KEEPALIVE_MODE=always python sandbox.py # keep alive for bg jobs

Config (env):
    DAYTONA_BASE_IMAGE         base image for new sandboxes (default debian:stable-slim)
    DAYTONA_PYTHON_VERSION     CPython installed via uv (default 3.14)
    DAYTONA_KEEPALIVE_MODE     ssh (default) | always | marker
    DAYTONA_KEEPALIVE_INTERVAL seconds between activity bumps (default 60)
    DAYTONA_KEEPALIVE_MARKER   marker file for job-scoped keepalive
    DAYTONA_TTL_MINUTES        also push the wall-clock TTL forward each bump
"""

import os
import pathlib
import sys

from daytona import CreateSandboxFromImageParams, Daytona, Resources

BASE_IMAGE = os.environ.get("DAYTONA_BASE_IMAGE", "ubuntu:26.04")
PYTHON_VERSION = os.environ.get("DAYTONA_PYTHON_VERSION", "3.14")
KEEPALIVE_MODE = os.environ.get("DAYTONA_KEEPALIVE_MODE", "ssh")
KEEPALIVE_INTERVAL = os.environ.get("DAYTONA_KEEPALIVE_INTERVAL", "60")
GIT_USER_NAME = os.environ.get("GIT_USER_NAME", "contributory")
GIT_USER_EMAIL = os.environ.get("GIT_USER_EMAIL", "bosuutap@alwaysdata.net")
PROVISION_MARKER = "/var/lib/daytona-provisioned"

if not os.environ.get("DAYTONA_API_KEY"):
    sys.exit("DAYTONA_API_KEY is not set. Export it before running.")

daytona = Daytona()


def run(sandbox, cmd: str, description: str) -> str:
    """Run a command inside the sandbox; raise on non-zero exit, else return result."""
    print(f"  - {description}...")
    resp = sandbox.process.exec(cmd)
    if resp.exit_code != 0:
        raise RuntimeError(
            f"'{description}' failed (exit {resp.exit_code}):\n{resp.result}"
        )
    return resp.result or ""


def provision(sandbox) -> None:
    """Idempotently install the toolchain + keepalive daemon (runs once per sandbox)."""
    probe = sandbox.process.exec(f"test -f {PROVISION_MARKER} && echo yes || echo no")
    if (probe.result or "").strip() == "yes":
        return

    print("Provisioning sandbox (first run only)...")
    r = sandbox.process.exec("id -u | grep -q '^0$' && echo '' || echo 'sudo -n'")
    sudo = (r.result or "").strip()

    run(
        sandbox,
        " && ".join(
            [
                f"{sudo} apt-get update -qq",
                (
                    f"{sudo} DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "
                    "sudo docker.io curl wget git ca-certificates tmux htop openssh-server "
                    # Deliberately no python3-pip: Debian/Ubuntu's pip is
                    # "externally managed" (PEP 668) and rejects system-wide
                    # `pip install`. pip is bootstrapped into the uv-managed
                    # Python further down instead.
                    "python3 python3-venv python3-pip python-is-python3"
                ),
                f"curl -fsSL https://deb.nodesource.com/setup_current.x | {sudo} bash -",
                f"{sudo} apt-get install -y -qq nodejs",
                # Latest Python via uv (replaces the distro-default python3 in
                # new shells; uv installs to $HOME/.local/bin).
                "curl -LsSf https://astral.sh/uv/install.sh | sh",
                'export PATH="$HOME/.local/bin:$PATH"',
                f"uv python install {PYTHON_VERSION}",
                f"UV_PY=$(uv python find {PYTHON_VERSION})",
                # Bootstrap pip into the uv-managed Python: its standalone
                # build has no EXTERNALLY-MANAGED marker, so system-wide
                # `pip install` works here (unlike distro python3-pip).
                'uv pip install --python "$UV_PY" --system pip',
                f'{sudo} ln -sf "$UV_PY" /usr/local/bin/python3',
                f'{sudo} ln -sf "$UV_PY" /usr/local/bin/python',
                # Point pip/pip3 at the uv Python's pip so `pip install`
                # never touches the distro's externally-managed pip.
                f'{sudo} ln -sf "$(dirname "$UV_PY")/pip3" /usr/local/bin/pip3',
                f'{sudo} ln -sf "$(dirname "$UV_PY")/pip3" /usr/local/bin/pip',
                # Git identity in user space (~/.gitconfig).
                f"git config --global user.name '{GIT_USER_NAME}'",
                f"git config --global user.email '{GIT_USER_EMAIL}'",
                "uv --version && python --version",
            ]
        ),
        "toolchain (docker, node, python, git, curl)",
    )

    # Keepalive daemon.
    script = pathlib.Path(__file__).with_name("keepalive.sh").read_bytes()
    sandbox.fs.upload_file(script, "/tmp/daytona-keepalive")
    run(
        sandbox,
        f"{sudo} install -m 0755 /tmp/daytona-keepalive /usr/local/bin/daytona-keepalive",
        "keepalive daemon",
    )

    run(sandbox, f"{sudo} touch {PROVISION_MARKER}", "mark as provisioned")


# 1. Resolve the sandbox: explicit id > existing usable sandbox > new one.
sandbox = None
explicit = os.environ.get("DAYTONA_SANDBOX_ID")
if explicit:
    sandbox = daytona.get(explicit)
    print(f"Using sandbox from DAYTONA_SANDBOX_ID: {explicit}")
else:
    usable = {"started", "stopped", "paused"}
    for s in daytona.list():
        if s.state in usable:
            sandbox = s
            print(f"Reusing existing sandbox: {s.id} (state={s.state})")
            break

if sandbox is None:
    print(f'Creating a new sandbox from "{BASE_IMAGE}"...')
    sandbox = daytona.create(
        CreateSandboxFromImageParams(
            image=BASE_IMAGE,
            resources=Resources(cpu=4, memory=8, disk=10),
            auto_stop_interval=5,  # default idle timeout; keepalive extends it
            auto_archive_interval=0,
        )
    )
    print(f"Created sandbox: {sandbox.id}")

# 2. Make sure it is started (stopped/paused -> start and wait for ready).
if sandbox.state in ("stopped", "paused"):
    print(f"Starting sandbox {sandbox.id}...")
    sandbox.start()
    print(f"Sandbox {sandbox.id} started.")

# 3. Provision toolchain + keepalive (idempotent, cached by marker file).
provision(sandbox)

# 4. Launch the keepalive daemon detached (setsid) so it survives this process
#    and keeps running for the sandbox's lifetime. Env vars are inlined because
#    commands launched through the SDK can't see create-time env vars.
env = {
    "DAYTONA_API_KEY": os.environ["DAYTONA_API_KEY"],
    "DAYTONA_SANDBOX_ID": sandbox.id,
    "DAYTONA_KEEPALIVE_MODE": KEEPALIVE_MODE,
    "DAYTONA_KEEPALIVE_INTERVAL": KEEPALIVE_INTERVAL,
}
for key in ("DAYTONA_KEEPALIVE_MARKER", "DAYTONA_TTL_MINUTES"):
    if os.environ.get(key):
        env[key] = os.environ[key]

env_str = " ".join(f"{k}='{v}'" for k, v in env.items())
cmd = (
    f"{env_str} setsid /usr/local/bin/daytona-keepalive "
    "</dev/null >/tmp/daytona-keepalive.log 2>&1 &"
)
sandbox.process.exec(cmd)
print("Keepalive daemon started (bumps activity while in use).")

# 5. Connection info: SSH token + web terminal.
ssh_access = sandbox.create_ssh_access(expires_in_minutes=60)
print()
print("── Connection ───────────────────────────────────────────────")
print(f"Sandbox ID:   {sandbox.id}")
print(f"SSH:          ssh {ssh_access.token}@ssh.app.daytona.io")
print(f"Web terminal: https://22222-{sandbox.id}.proxy.daytona.work")
print(f"(CLI:         daytona ssh {sandbox.id})")
print("──────────────────────────────────────────────────────────────")
