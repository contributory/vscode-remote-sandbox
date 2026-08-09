# Remote Sandbox

Remote Sandbox manages sandboxed environments — **E2B**, **Daytona** and **Runloop** — and helps you connect to them over SSH from VS Code.

The extension provides a **Sandboxes** view in the Activity Bar (like Remote Extended) that lists your E2B sandboxes, Daytona sandboxes and Runloop devboxes. Connecting to a sandbox **starts/resumes it, writes the matching `~/.ssh/*.conf` file if needed, and opens Remote-SSH** — no manual "get SSH info" step required.

## Requirements

- VS Code 1.80.0 or later
- Remote - SSH extension
- Node.js 18 or later for development
- API keys for the providers you use (see Configuration)

## Installation

### Run from source

```bash
npm install
npm run compile
```

Open the project in VS Code and press `F5` to launch an Extension Development Host.

### Package a VSIX

```bash
npm install -g @vscode/vsce
vsce package
```

Install the generated VSIX from the Extensions view.

## Usage

Open the **Remote Sandbox** view in the Activity Bar. The tree shows one section per provider:

- **E2B Sandboxes** — list of your E2B sandboxes. Connecting writes the SSH config (if needed) and opens Remote-SSH.
- **Daytona Sandboxes** — list of your Daytona sandboxes. Connecting starts the sandbox, mints a fresh SSH access token when the stored one is missing or expired, and opens Remote-SSH.
- **Runloop Devboxes** — list of your devboxes with actions to create, suspend, resume, snapshot, or connect. Connecting creates the SSH key and writes the config (only when needed) and opens Remote-SSH.

Each item has a context menu to **Connect in Current Window** or **Connect in New Window**. Next to the connect buttons, each sandbox/devbox shows a lifecycle toggle:

- **E2B**: **Pause** when running, **Resume** when paused.
- **Daytona**: **Stop** when started, **Start** when stopped.
- **Runloop**: **Suspend** when running, **Resume** when suspended.

The view title bar has a shortcut for:

- Refresh

All commands are also available from the Command Palette.

## SSH configuration

Each provider manages its own SSH config file under `~/.ssh` and only writes it when needed:

- **E2B** (`~/.ssh/e2b.conf`) — the entry is fully deterministic, so it is rewritten only when the file is missing or does not match.
- **Daytona** (`~/.ssh/daytona.conf`) — each entry records an `# expiresAt:` timestamp. A fresh SSH access token is minted and the file rewritten only when the entry is missing or expired (with a 5-minute buffer).
- **Runloop** (`~/.ssh/runloop.conf` + `~/.ssh/runloop_key`) — the SSH key is created and the file rewritten only when this devbox's entry is missing or the key file is absent.

The config is (re)written automatically as part of **Connect in Current Window**, **Connect in New Window**, **Resume** and **Start** actions — whenever a check shows the stored config is outdated. The standalone "Get SSH Info" / "Save SSH Config" commands were removed.

Each provider writes its own `.conf` file and prints the `Include` line to the output channel; make sure that line is present in `~/.ssh/config`.

## Configuration

Open Settings and search for `Remote Sandbox`.

```json
{
  "remoteSandbox.e2bApiKey": "",
  "remoteSandbox.daytonaApiKey": "",
  "remoteSandbox.daytonaApiUrl": "https://app.daytona.io/api",
  "remoteSandbox.daytonaSshExpiresInMinutes": 60,
  "remoteSandbox.runloopApiKey": ""
}
```

- `remoteSandbox.e2bApiKey`: Your E2B API key. You can also set it with the **E2B: Set API Key** command or the `E2B_API_KEY` environment variable.
- `remoteSandbox.daytonaApiKey`: Your Daytona API key. You can also set it with the **Daytona: Set API Key** command or the `DAYTONA_API_KEY` environment variable.
- `remoteSandbox.daytonaApiUrl`: Base URL of the Daytona API (change only for self-hosted Daytona).
- `remoteSandbox.daytonaSshExpiresInMinutes`: Expiration (minutes) for the generated Daytona SSH access token.
- `remoteSandbox.runloopApiKey`: Your Runloop API key. You can also set it with the **Runloop: Set API Key** command or the `RUNLOOP_API_KEY` environment variable.

## Troubleshooting

- Check the Remote Sandbox output channel for operation details and errors.
- Verify the generated configuration file is included by `~/.ssh/config` (each provider writes its own `.conf` file and prints the `Include` line to the output channel).
- Confirm the required API keys and tools (`websocat` for E2B) are available.

## License

GPL-3.0-only
