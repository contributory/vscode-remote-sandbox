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

// Create-sandbox defaults (mirror the reference daytona/sandbox.py).
const DEFAULT_IMAGE = "ubuntu:26.04";
const DEFAULT_CPU = 4;
const DEFAULT_MEMORY_GB = 8;
const DEFAULT_DISK_GB = 10;
const DEFAULT_AUTO_STOP_MIN = 5;

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

/** Default create-sandbox settings, mirroring the reference daytona/sandbox.py. */
function getDaytonaCreateDefaults(): {
  image: string;
  cpu: number;
  memory: number;
  disk: number;
  autoStopInterval: number;
} {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const image = config.get<string>("daytonaImage");
  const cpu = config.get<number>("daytonaCpu");
  const memory = config.get<number>("daytonaMemory");
  const disk = config.get<number>("daytonaDisk");
  const autoStop = config.get<number>("daytonaAutoStopInterval");
  return {
    image: image && image.trim() ? image.trim() : DEFAULT_IMAGE,
    cpu: cpu && cpu > 0 ? cpu : DEFAULT_CPU,
    memory: memory && memory > 0 ? memory : DEFAULT_MEMORY_GB,
    disk: disk && disk > 0 ? disk : DEFAULT_DISK_GB,
    autoStopInterval:
      autoStop !== undefined && autoStop >= 0 ? autoStop : DEFAULT_AUTO_STOP_MIN,
  };
}

export function registerDaytonaCommands(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  const disposable = vscode.commands.registerCommand(
    "remote-sandbox.daytonaGetSandboxSshInfo",
    async () => {
      await fetchDaytonaSshConfig(outputChannel);
    },
  );

  context.subscriptions.push(disposable);
}

/** Lists the Daytona sandboxes visible to the configured API key. Returns []
 * when the API key is missing or the request fails. */
export async function listDaytonaSandboxes(): Promise<DaytonaSandbox[]> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    return [];
  }
  const apiUrl = getDaytonaApiUrl();
  try {
    const response = await daytonaRequest<ListSandboxesResponse>(
      "/sandbox?limit=100",
      apiKey,
      apiUrl,
    );
    return response.items ?? [];
  } catch {
    return [];
  }
}

/** Creates a new Daytona sandbox from the configured base image. Mirrors the
 * reference daytona/sandbox.py (image + resources + idle auto-stop). */
export async function createDaytonaSandbox(
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    promptDaytonaApiKey();
    return;
  }

  const apiUrl = getDaytonaApiUrl();
  const defaults = getDaytonaCreateDefaults();
  outputChannel.show(true);

  try {
    const sandbox = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating Daytona sandbox (image: ${defaults.image})...`,
        cancellable: false,
      },
      () =>
        daytonaRequest<DaytonaSandbox>("/sandbox", apiKey, apiUrl, "POST", {
          cpu: defaults.cpu,
          memory: defaults.memory,
          disk: defaults.disk,
          autoStopInterval: defaults.autoStopInterval,
          autoArchiveInterval: 0,
          // Daytona's REST API builds from a Dockerfile rather than a bare
          // image reference, so wrap the image in a minimal FROM directive.
          buildInfo: { dockerfileContent: `FROM ${defaults.image}` },
        }),
    );

    outputChannel.appendLine(`[Daytona] Created sandbox: ${sandbox.id}`);
    vscode.window.showInformationMessage(
      `Daytona sandbox created: ${sandbox.name || sandbox.id}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to create Daytona sandbox: ${message}`,
    );
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

/** Deletes a Daytona sandbox after confirmation. This is irreversible. */
export async function deleteDaytonaSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    promptDaytonaApiKey();
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete Daytona sandbox ${sandboxId}? This cannot be undone.`,
    { modal: true },
    "Delete",
  );
  if (confirm !== "Delete") {
    return;
  }

  const apiUrl = getDaytonaApiUrl();
  try {
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
    vscode.window.showInformationMessage(
      `Daytona sandbox deleted: ${sandboxId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to delete Daytona sandbox: ${message}`,
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

    outputChannel.appendLine("[Daytona] Creating SSH access token...");
    const expiresInMinutes = getSshExpiresInMinutes();
    const sshAccess = await daytonaRequest<DaytonaSshAccess>(
      `/sandbox/${encodeURIComponent(sandboxId)}/ssh-access?expiresInMinutes=${expiresInMinutes}`,
      apiKey,
      apiUrl,
      "POST",
    );

    const target = resolveSshTarget(sshAccess);
    const hostAlias = getDaytonaHostAlias(sandboxId);
    const configPath = writeDaytonaConfig(sandboxId, target, outputChannel);
    outputChannel.appendLine(`[Daytona] SSH config written to: ${configPath}`);
    return hostAlias;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error: ${message}`);
    vscode.window.showErrorMessage(`Daytona SSH Error: ${message}`);
    return undefined;
  }
}

export async function fetchDaytonaSshConfig(
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getDaytonaApiKey();
  if (!apiKey) {
    outputChannel.appendLine(
      "[Daytona] API key is not configured. Aborting.",
    );
    promptDaytonaApiKey();
    return;
  }

  const apiUrl = getDaytonaApiUrl();
  outputChannel.show(true);

  try {
    outputChannel.appendLine("[Daytona] Looking for an existing sandbox...");
    const response = await daytonaRequest<ListSandboxesResponse>(
      "/sandbox?limit=100",
      apiKey,
      apiUrl,
    );
    const sandbox = (response.items ?? [])[0];

    if (!sandbox) {
      outputChannel.appendLine("[Daytona] No sandbox found.");
      vscode.window.showWarningMessage(
        "No Daytona sandbox found. Please create a sandbox first.",
      );
      return;
    }

    const hostAlias = await connectDaytonaSandbox(sandbox.id, outputChannel);
    if (hostAlias) {
      vscode.window.showInformationMessage(
        `Daytona SSH config saved (Host: ${hostAlias})`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Daytona] Error: ${message}`);
    vscode.window.showErrorMessage(`Daytona SSH Error: ${message}`);
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

function writeDaytonaConfig(
  sandboxId: string,
  target: ParsedSshTarget,
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
    "    StrictHostKeyChecking no\n" + "    UserKnownHostsFile /dev/null\n";

  const configPath = path.join(sshDir, "daytona.conf");

  fs.writeFileSync(configPath, configContent, { mode: 0o600 });
  outputChannel.appendLine(`[Daytona] Config:\n${configContent}`);
  outputChannel.appendLine("[Daytona] Ensure ~/.ssh/config contains:");
  outputChannel.appendLine(`Include "${configPath}"`);

  return configPath;
}
