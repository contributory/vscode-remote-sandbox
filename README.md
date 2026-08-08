# Remote Sandbox

Remote Sandbox manages sandboxed environments — **E2B**, **Daytona** and **Runloop** — and helps you connect to them over SSH from VS Code.

The extension provides a **Sandboxes** view in the Activity Bar (like Remote Extended) that lists your E2B sandboxes, Daytona sandboxes and Runloop devboxes, plus quick actions to fetch SSH configs or connect in the current/new window.

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

- **E2B Sandboxes** — list of your E2B sandboxes. Connect to one to write its SSH config and open Remote-SSH.
- **Daytona Sandboxes** — list of your Daytona sandboxes. Connecting starts the sandbox, mints an SSH access token and opens Remote-SSH.
- **Runloop Devboxes** — list of your devboxes with actions to create, suspend, resume, snapshot, or connect.

Each item has a context menu to **Connect in Current Window** or **Connect in New Window**. The view title bar has shortcuts for:

- Refresh
- Runloop: Create Devbox
- Runloop: Select Devbox & Save SSH Config
- E2B: Get Sandbox SSH Info
- Daytona: Get Sandbox SSH Info

All commands are also available from the Command Palette.

## Configuration

Open Settings and search for `Remote Sandbox`.

```json
{
  "remoteSandbox.e2bApiKey": "",
  "remoteSandbox.e2bTemplateId": "ssh-ready",
  "remoteSandbox.daytonaApiKey": "",
  "remoteSandbox.daytonaApiUrl": "https://app.daytona.io/api",
  "remoteSandbox.daytonaSshExpiresInMinutes": 60,
  "remoteSandbox.runloopApiKey": ""
}
```

- `remoteSandbox.e2bApiKey`: Your E2B API key. You can also set it with the **E2B: Set API Key** command or the `E2B_API_KEY` environment variable.
- `remoteSandbox.e2bTemplateId`: E2B template ID used when creating a new sandbox.
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
