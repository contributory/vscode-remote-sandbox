import * as vscode from "vscode";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const E2B_API_URL = "https://api.e2b.app";
const SANDBOX_TIMEOUT_SECONDS = 300;

export interface E2BSandbox {
  sandboxID: string;
  state?: "running" | "paused";
}

export function getE2bApiKey(): string | undefined {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const apiKey = config.get<string>("e2bApiKey");
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey.trim();
  }
  const env = process.env["E2B_API_KEY"];
  if (env && env.trim().length > 0) {
    return env.trim();
  }
  return undefined;
}

export function hasE2bApiKey(): boolean {
  return getE2bApiKey() !== undefined;
}

/** Template ID used when creating a new E2B sandbox (defaults to "ssh-ready"). */
function getE2bTemplateId(): string {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const templateId = config.get<string>("e2bTemplateId");
  if (templateId && templateId.trim().length > 0) {
    return templateId.trim();
  }
  return "ssh-ready";
}

/** Prompts for and saves the E2B API key to settings (Runloop-style). */
export async function setE2bApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your E2B API key",
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
    .update("e2bApiKey", trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("E2B API key saved to settings.");
}

function promptE2bApiKey(): void {
  vscode.window
    .showWarningMessage(
      "No E2B API key found. Please provide one, set the remoteSandbox.e2bApiKey setting, or set the E2B_API_KEY environment variable.",
      "Set API Key",
    )
    .then((selection) => {
      if (selection === "Set API Key") {
        vscode.commands.executeCommand("remote-sandbox.e2bSetApiKey");
      }
    });
}

export function registerE2bCommands(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  const disposable = vscode.commands.registerCommand(
    "remote-sandbox.e2bGetSandboxSshInfo",
    async () => {
      await fetchE2bSshConfig(outputChannel);
    },
  );

  context.subscriptions.push(disposable);
}

/** Lists the E2B sandboxes visible to the configured API key. Returns [] when
 * the API key is missing or the request fails. */
export async function listE2bSandboxes(): Promise<E2BSandbox[]> {
  const apiKey = getE2bApiKey();
  if (!apiKey) {
    return [];
  }
  try {
    const sandboxes = await e2bRequest<E2BSandbox[]>(
      "/v2/sandboxes?limit=100",
      apiKey,
    );
    return Array.isArray(sandboxes) ? sandboxes : [];
  } catch {
    return [];
  }
}

/** Creates a new E2B sandbox from the configured template. Mirrors the
 * reference e2b/sandbox.js: TTL with auto-pause + auto-resume so the sandbox
 * pauses when idle and comes back on reconnect. */
export async function createE2bSandbox(
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getE2bApiKey();
  if (!apiKey) {
    promptE2bApiKey();
    return;
  }

  const templateId = getE2bTemplateId();
  outputChannel.show(true);

  try {
    const sandbox = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating E2B sandbox (template: ${templateId})...`,
        cancellable: false,
      },
      () =>
        e2bRequest<{ sandboxID: string }>("/sandboxes", apiKey, "POST", {
          templateID: templateId,
          timeout: SANDBOX_TIMEOUT_SECONDS,
          autoPause: true,
          autoResume: { enabled: true },
        }),
    );

    outputChannel.appendLine(`[E2B] Created sandbox: ${sandbox.sandboxID}`);
    vscode.window.showInformationMessage(
      `E2B sandbox created: ${sandbox.sandboxID}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[E2B] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to create E2B sandbox: ${message}`);
  }
}

/** Pauses a running E2B sandbox. State is preserved and it can be resumed by
 * reconnecting. */
export async function pauseE2bSandbox(
  sandboxID: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getE2bApiKey();
  if (!apiKey) {
    promptE2bApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pausing E2B sandbox ${sandboxID}...`,
        cancellable: false,
      },
      () =>
        e2bRequest(
          `/sandboxes/${encodeURIComponent(sandboxID)}/pause`,
          apiKey,
          "POST",
        ),
    );
    outputChannel.appendLine(`[E2B] Paused sandbox: ${sandboxID}`);
    vscode.window.showInformationMessage(
      `E2B sandbox paused: ${sandboxID}. Reconnect to resume it.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[E2B] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to pause E2B sandbox: ${message}`);
  }
}

/** Resumes a paused E2B sandbox. State is preserved and can be paused again. */
export async function resumeE2bSandbox(
  sandboxID: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getE2bApiKey();
  if (!apiKey) {
    promptE2bApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Resuming E2B sandbox ${sandboxID}...`,
        cancellable: false,
      },
      () =>
        e2bRequest(
          `/sandboxes/${encodeURIComponent(sandboxID)}/connect`,
          apiKey,
          "POST",
          { timeout: SANDBOX_TIMEOUT_SECONDS },
        ),
    );
    outputChannel.appendLine(`[E2B] Resumed sandbox: ${sandboxID}`);
    vscode.window.showInformationMessage(`E2B sandbox resumed: ${sandboxID}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[E2B] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to resume E2B sandbox: ${message}`);
  }
}

/** Kills (deletes) an E2B sandbox after confirmation. This is irreversible.
 * Not exposed in the UI; only available via the command palette. */
export async function deleteE2bSandbox(
  sandboxID: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getE2bApiKey();
  if (!apiKey) {
    promptE2bApiKey();
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Kill E2B sandbox ${sandboxID}? This cannot be undone.`,
    { modal: true },
    "Kill",
  );
  if (confirm !== "Kill") {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Killing E2B sandbox ${sandboxID}...`,
        cancellable: false,
      },
      () =>
        e2bRequest(
          `/sandboxes/${encodeURIComponent(sandboxID)}`,
          apiKey,
          "DELETE",
        ),
    );
    outputChannel.appendLine(`[E2B] Killed sandbox: ${sandboxID}`);
    vscode.window.showInformationMessage(`E2B sandbox killed: ${sandboxID}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[E2B] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to kill E2B sandbox: ${message}`);
  }
}

/** Resumes (if needed) a specific E2B sandbox, writes its SSH config and
 * returns the SSH host alias. Returns undefined on failure. */
export async function connectE2bSandbox(
  sandboxID: string,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getE2bApiKey();
  if (!apiKey) {
    outputChannel.appendLine("[E2B] API key is not configured. Aborting.");
    promptE2bApiKey();
    return undefined;
  }

  outputChannel.show(true);

  try {
    const sandbox = await e2bRequest<E2BSandbox>(
      `/sandboxes/${encodeURIComponent(sandboxID)}`,
      apiKey,
    );

    if (sandbox.state === "paused") {
      outputChannel.appendLine(`[E2B] Resuming sandbox: ${sandboxID}`);
      await e2bRequest(
        `/sandboxes/${encodeURIComponent(sandboxID)}/connect`,
        apiKey,
        "POST",
        {
          timeout: SANDBOX_TIMEOUT_SECONDS,
        },
      );
    }

    const hostAlias = getE2bHostAlias(sandboxID);
    const configPath = writeE2bConfig(sandboxID, outputChannel);
    outputChannel.appendLine(`[E2B] SSH config written to: ${configPath}`);
    return hostAlias;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[E2B] Error: ${message}`);
    vscode.window.showErrorMessage(`E2B SSH Error: ${message}`);
    return undefined;
  }
}

export async function fetchE2bSshConfig(
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getE2bApiKey();
  if (!apiKey) {
    outputChannel.appendLine("[E2B] API key is not configured. Aborting.");
    promptE2bApiKey();
    return;
  }

  outputChannel.show(true);

  try {
    outputChannel.appendLine("[E2B] Looking for an existing sandbox...");
    const sandboxes = await e2bRequest<E2BSandbox[]>(
      "/v2/sandboxes?limit=100",
      apiKey,
    );
    const sandbox = sandboxes[0];

    if (!sandbox) {
      outputChannel.appendLine("[E2B] No sandbox found.");
      vscode.window.showWarningMessage(
        "No E2B sandbox found. Please create a sandbox first.",
      );
      return;
    }

    const hostAlias = await connectE2bSandbox(sandbox.sandboxID, outputChannel);
    if (hostAlias) {
      vscode.window.showInformationMessage(
        `E2B SSH config saved (Host: ${hostAlias})`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[E2B] Error: ${message}`);
    vscode.window.showErrorMessage(`E2B SSH Error: ${message}`);
  }
}

function e2bRequest<T>(
  requestPath: string,
  apiKey: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(
      `${E2B_API_URL}${requestPath}`,
      {
        method,
        headers: {
          "X-API-Key": apiKey,
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
            // Some endpoints (pause, kill) return 204 with no body.
            if (!data.trim()) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error("E2B API returned an invalid JSON response."));
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
              `E2B API request failed (${response.statusCode ?? 0}): ${message}`,
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

function getE2bHostAlias(sandboxID: string): string {
  return `E2B_${sandboxID}`;
}

function writeE2bConfig(
  sandboxID: string,
  outputChannel: vscode.OutputChannel,
): string {
  const sshDir = path.join(os.homedir(), ".ssh");
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  const configContent =
    `Host ${getE2bHostAlias(sandboxID)}\n` +
    `    ProxyCommand websocat --binary -B 65536 - wss://8081-${sandboxID}.e2b.app\n` +
    `    HostName ${sandboxID}\n` +
    "    User user\n";
  const configPath = path.join(sshDir, "e2b.conf");

  fs.writeFileSync(configPath, configContent, { mode: 0o600 });
  outputChannel.appendLine(`[E2B] Config:\n${configContent}`);
  outputChannel.appendLine("[E2B] Ensure ~/.ssh/config contains:");
  outputChannel.appendLine(`Include "${configPath}"`);

  return configPath;
}
