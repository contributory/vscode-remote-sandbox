import * as vscode from "vscode";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// Daytona SSH integration: list a sandbox, start/resume it, mint a token-based
// SSH access, and write ~/.ssh/daytona.conf for a direct SSH connection.
const DEFAULT_DAYTONA_API_URL = "https://app.daytona.io/api";
const DEFAULT_SSH_HOST = "ssh.app.daytona.io";
const DEFAULT_SSH_EXPIRES_MINUTES = 60;
const START_POLL_ATTEMPTS = 30;
const START_POLL_INTERVAL_MS = 2000;

export interface DaytonaSandbox {
  id: string;
  name?: string;
  state?: string;
}

interface ListSandboxesResponse {
  items: DaytonaSandbox[];
  nextCursor?: string | null;
}

interface DaytonaSshAccess {
  token: string;
  sshCommand: string;
  expiresAt?: string;
}

interface ParsedSshTarget {
  user: string;
  host: string;
  port?: number;
}

export function getDaytonaApiKey(): string | undefined {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const apiKey = config.get<string>("daytonaApiKey");
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey.trim();
  }
  const env = process.env["DAYTONA_API_KEY"];
  if (env && env.trim().length > 0) {
    return env.trim();
  }
  return undefined;
}

export function hasDaytonaApiKey(): boolean {
  return getDaytonaApiKey() !== undefined;
}

/** Prompts for and saves the Daytona API key to settings (Runloop-style). */
export async function setDaytonaApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your Daytona API key",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    vscode.window.showErrorMessage("API key cannot be empty.");
    return;
  }
  await vscode.workspace
    .getConfiguration("remoteSandbox")
    .update("daytonaApiKey", trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("Daytona API key saved to settings.");
}

function promptDaytonaApiKey(): void {
  vscode.window
    .showWarningMessage(
      "No Daytona API key found. Please provide one, set the remoteSandbox.daytonaApiKey setting, or set the DAYTONA_API_KEY environment variable.",
      "Set API Key",
    )
    .then((selection) => {
      if (selection === "Set API Key") {
        vscode.commands.executeCommand("remote-sandbox.daytonaSetApiKey");
      }
    });
}

function getDaytonaApiUrl(): string {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const url = config.get<string>("daytonaApiUrl");
  if (!url || url.trim().length === 0) {
    return DEFAULT_DAYTONA_API_URL;
  }
  return url.trim().replace(/\/$/, "");
}

function getSshExpiresInMinutes(): number {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const minutes = config.get<number>("daytonaSshExpiresInMinutes");
  if (!minutes || minutes <= 0) {
    return DEFAULT_SSH_EXPIRES_MINUTES;
  }
  return minutes;
}

/** Lists the Daytona sandboxes visible to the configured API key. Returns []
 * when the API key is missing or the request fails. When `outputChannel` is
 * provided, errors and unexpected responses are logged there. */
export async function listDaytonaSandboxes(
  outputChannel?: vscode.OutputChannel,
): Promise<DaytonaSandbox[]> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    return [];
  }
  const apiUrl = getDaytonaApiUrl();
  try {
    // Official spec: GET /sandbox (listSandboxes) returns ListSandboxesResponse
    // = { items: SandboxListItem[], nextCursor }. The separate, deprecated
    // /sandbox/paginated endpoint also wraps results in { items, ... }. Prefer
    // the { items } wrapper and keep a defensive plain-array fallback in case
    // an older server still returns a bare array.
    const response = await daytonaRequest<unknown>("/sandbox", apiKey, apiUrl);
    const list = response as Partial<ListSandboxesResponse>;
    if (Array.isArray(list.items)) {
      return list.items;
    }
    if (Array.isArray(response)) {
      return response as DaytonaSandbox[];
    }
    outputChannel?.appendLine(
      "[Daytona] Unexpected response shape from GET /sandbox; no sandboxes found.",
    );
    return [];
  } catch (error) {
    if (outputChannel) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Daytona] Error listing sandboxes: ${message}`);
    }
    return [];
  }
}

/** Stops a running Daytona sandbox. State is preserved; it can be started
 * again by reconnecting. */
export async function stopDaytonaSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    promptDaytonaApiKey();
    return;
  }

  const apiUrl = getDaytonaApiUrl();
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Stopping Daytona sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        daytonaRequest(
          `/sandbox/${encodeURIComponent(sandboxId)}/stop`,
          apiKey,
          apiUrl,
          "POST",
        ),
    );
    outputChannel.appendLine(`[Daytona] Stopped sandbox: ${sandboxId}`);
    vscode.window.showInformationMessage(
      `Daytona sandbox stopped: ${sandboxId}. Reconnect to start it again.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to stop Daytona sandbox: ${message}`,
    );
  }
}

/** Creates a new Daytona sandbox. Prompts the user for a name.
 * API: POST /sandbox */
export async function createDaytonaSandbox(
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    promptDaytonaApiKey();
    return undefined;
  }

  const apiUrl = getDaytonaApiUrl();
  try {
    const name = await vscode.window.showInputBox({
      prompt: "New Daytona sandbox name (optional)",
      placeHolder: "my-sandbox",
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return undefined;
    }

    const sandbox = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Creating Daytona sandbox...",
        cancellable: false,
      },
      () =>
        daytonaRequest<DaytonaSandbox>(
          `/sandbox`,
          apiKey,
          apiUrl,
          "POST",
          name.trim() ? { name: name.trim() } : undefined,
        ),
    );

    const label = sandbox.name || sandbox.id;
    outputChannel.appendLine(`[Daytona] Created sandbox: ${label} (${sandbox.id})`);
    vscode.window.showInformationMessage(
      `Daytona sandbox created: ${label} (${sandbox.id})`,
    );
    return sandbox.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error creating sandbox: ${message}`);
    vscode.window.showErrorMessage(`Failed to create Daytona sandbox: ${message}`);
    return undefined;
  }
}

/** Deletes a Daytona sandbox (permanently). */
export async function deleteDaytonaSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    promptDaytonaApiKey();
    return;
  }

  const apiUrl = getDaytonaApiUrl();
  try {
    const confirm = await vscode.window.showWarningMessage(
      `Delete Daytona sandbox ${sandboxId}? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting Daytona sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        daytonaRequest(
          `/sandbox/${encodeURIComponent(sandboxId)}`,
          apiKey,
          apiUrl,
          "DELETE",
        ),
    );
    outputChannel.appendLine(`[Daytona] Deleted sandbox: ${sandboxId}`);
    vscode.window.showInformationMessage(`Daytona sandbox deleted: ${sandboxId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to delete Daytona sandbox: ${message}`);
  }
}

/** Starts a stopped Daytona sandbox. */
export async function startDaytonaSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    promptDaytonaApiKey();
    return;
  }

  const apiUrl = getDaytonaApiUrl();
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting Daytona sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        daytonaRequest(
          `/sandbox/${encodeURIComponent(sandboxId)}/start`,
          apiKey,
          apiUrl,
          "POST",
        ),
    );
    outputChannel.appendLine(`[Daytona] Started sandbox: ${sandboxId}`);
    vscode.window.showInformationMessage(
      `Daytona sandbox started: ${sandboxId}.`,
    );

    // Make sure the SSH config holds a valid token so "Connect in..." works
    // right away (best-effort — never fail the start on config errors).
    try {
      await ensureDaytonaSshConfig(sandboxId, outputChannel);
    } catch (ensureErr) {
      const ensureMessage =
        ensureErr instanceof Error ? ensureErr.message : String(ensureErr);
      outputChannel.appendLine(
        `[Daytona] Warning: could not refresh SSH config: ${ensureMessage}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to start Daytona sandbox: ${message}`,
    );
  }
}

/** Starts (if needed) a specific Daytona sandbox, mints an SSH access token,
 * writes its SSH config and returns the SSH host alias. Returns undefined on
 * failure. */
export async function connectDaytonaSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    outputChannel.appendLine(
      "[Daytona] API key is not configured. Aborting.",
    );
    promptDaytonaApiKey();
    return undefined;
  }

  const apiUrl = getDaytonaApiUrl();
  outputChannel.show(true);

  try {
    let sandbox = await daytonaRequest<DaytonaSandbox>(
      `/sandbox/${encodeURIComponent(sandboxId)}`,
      apiKey,
      apiUrl,
    );

    if (sandbox.state !== "started") {
      outputChannel.appendLine(`[Daytona] Starting sandbox: ${sandboxId}`);
      await daytonaRequest(
        `/sandbox/${encodeURIComponent(sandboxId)}/start`,
        apiKey,
        apiUrl,
        "POST",
      );
      sandbox = await waitForSandboxStarted(
        sandboxId,
        apiKey,
        apiUrl,
        outputChannel,
      );
    }

    return await ensureDaytonaSshConfig(sandboxId, outputChannel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error: ${message}`);
    vscode.window.showErrorMessage(`Daytona SSH Error: ${message}`);
    return undefined;
  }
}

async function waitForSandboxStarted(
  sandboxId: string,
  apiKey: string,
  apiUrl: string,
  outputChannel: vscode.OutputChannel,
): Promise<DaytonaSandbox> {
  for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt++) {
    const sandbox = await daytonaRequest<DaytonaSandbox>(
      `/sandbox/${encodeURIComponent(sandboxId)}`,
      apiKey,
      apiUrl,
    );

    if (sandbox.state === "started") {
      outputChannel.appendLine("[Daytona] Sandbox is started.");
      return sandbox;
    }

    if (sandbox.state === "error" || sandbox.state === "build_failed") {
      throw new Error(
        `Sandbox entered an unrecoverable state: ${sandbox.state}`,
      );
    }

    outputChannel.appendLine(
      `[Daytona] Waiting for sandbox to start (state: ${sandbox.state ?? "unknown"})...`,
    );
    await delay(START_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for the sandbox to start.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daytonaRequest<T>(
  requestPath: string,
  apiKey: string,
  apiUrl: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(
      `${apiUrl}${requestPath}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(requestBody
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(requestBody),
              }
            : {}),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          if (
            response.statusCode &&
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            if (!data.trim()) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(
                new Error("Daytona API returned an invalid JSON response."),
              );
            }
            return;
          }

          let message =
            data.trim() || response.statusMessage || "Unknown error";
          try {
            const error = JSON.parse(data) as { message?: string };
            message = error.message ?? message;
          } catch {
            // Use the response body when it is not JSON.
          }
          reject(
            new Error(
              `Daytona API request failed (${response.statusCode ?? 0}): ${message}`,
            ),
          );
        });
      },
    );

    request.on("error", reject);
    if (requestBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

/**
 * Resolves the SSH connection target. The token is always the SSH user; the
 * host and port are parsed from the API-provided command so that self-hosted
 * Daytona gateways keep working.
 */
function resolveSshTarget(sshAccess: DaytonaSshAccess): ParsedSshTarget {
  const parsed = parseSshCommand(sshAccess.sshCommand);
  return {
    user: sshAccess.token,
    host: parsed?.host ?? DEFAULT_SSH_HOST,
    port: parsed?.port,
  };
}

function parseSshCommand(
  sshCommand: string | undefined,
): ParsedSshTarget | null {
  if (!sshCommand) {
    return null;
  }

  const portMatch = sshCommand.match(/-p\s+(\d+)/i);
  const port = portMatch ? parseInt(portMatch[1], 10) : undefined;

  const userHostMatch = sshCommand.match(/([^\s@]+)@([^\s]+)/);
  if (!userHostMatch) {
    return null;
  }

  return { user: userHostMatch[1], host: userHostMatch[2], port };
}

function getDaytonaHostAlias(sandboxId: string): string {
  return `DTN_${sandboxId}`;
}

function getDaytonaConfigPath(): string {
  return path.join(os.homedir(), ".ssh", "daytona.conf");
}

/**
 * True when daytona.conf already holds a valid (not yet expired) block for the
 * given host alias. Each block stores a `# expiresAt:` comment so we can decide
 * whether a fresh SSH access token is needed without calling the API.
 */
function isDaytonaConfigCurrent(alias: string): boolean {
  const configPath = getDaytonaConfigPath();
  if (!fs.existsSync(configPath)) {
    return false;
  }
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  const block = extractDaytonaBlock(content, alias);
  if (!block) {
    return false;
  }
  const expiresMatch = block.match(/#\s*expiresAt:\s*(\S+)/);
  if (!expiresMatch) {
    return false;
  }
  const expiresAt = Date.parse(expiresMatch[1]);
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  // Keep a small buffer so a token that is about to expire is refreshed.
  return expiresAt > Date.now() + 5 * 60000;
}

/** Returns the config block for `alias` (from its `Host` line up to the next
 * `Host` line or the end of the file), or null when absent. */
function extractDaytonaBlock(content: string, alias: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `Host ${alias}`);
  if (start < 0) {
    return null;
  }
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^\s*Host\s+/i.test(lines[i])) {
      break;
    }
    block.push(lines[i]);
  }
  return block.join("\n");
}

/**
 * Ensures ~/.ssh/daytona.conf holds a valid entry for this sandbox. A block is
 * considered current when it exists for this sandbox AND the SSH access token
 * embedded in it has not yet expired. Mints a fresh token and writes the config
 * only when the block is missing or stale. Returns the SSH host alias.
 */
async function ensureDaytonaSshConfig(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const alias = getDaytonaHostAlias(sandboxId);
  if (isDaytonaConfigCurrent(alias)) {
    outputChannel.appendLine(
      `[Daytona] SSH config already up to date (Host: ${alias}).`,
    );
    return alias;
  }

  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    outputChannel.appendLine("[Daytona] API key is not configured. Aborting.");
    promptDaytonaApiKey();
    return undefined;
  }

  outputChannel.appendLine("[Daytona] Creating SSH access token...");
  const expiresInMinutes = getSshExpiresInMinutes();
  const sshAccess = await daytonaRequest<DaytonaSshAccess>(
    `/sandbox/${encodeURIComponent(sandboxId)}/ssh-access?expiresInMinutes=${expiresInMinutes}`,
    apiKey,
    getDaytonaApiUrl(),
    "POST",
  );

  const target = resolveSshTarget(sshAccess);
  const expiresAt =
    sshAccess.expiresAt ??
    new Date(Date.now() + expiresInMinutes * 60000).toISOString();
  const configPath = writeDaytonaConfig(sandboxId, target, expiresAt, outputChannel);
  outputChannel.appendLine(`[Daytona] SSH config written to: ${configPath}`);
  return alias;
}

function writeDaytonaConfig(
  sandboxId: string,
  target: ParsedSshTarget,
  expiresAt: string,
  outputChannel: vscode.OutputChannel,
): string {
  const sshDir = path.join(os.homedir(), ".ssh");
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  let configContent =
    `Host ${getDaytonaHostAlias(sandboxId)}\n` +
    `    HostName ${target.host}\n` +
    `    User ${target.user}\n`;
  if (target.port) {
    configContent += `    Port ${target.port}\n`;
  }
  configContent +=
    "    StrictHostKeyChecking no\n" +
    "    UserKnownHostsFile /dev/null\n" +
    `    # expiresAt: ${expiresAt}\n`;

  const configPath = path.join(sshDir, "daytona.conf");

  fs.writeFileSync(configPath, configContent, { mode: 0o600 });
  outputChannel.appendLine(`[Daytona] Config:\n${configContent}`);
  outputChannel.appendLine("[Daytona] Ensure ~/.ssh/config contains:");
  outputChannel.appendLine(`Include "${configPath}"`);

  return configPath;
}
