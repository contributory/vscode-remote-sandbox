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

/** Lists the E2B sandboxes visible to the configured API key. Returns [] when
 * the API key is missing or the request fails. When `outputChannel` is
 * provided, the listed count and any errors are logged there. */
export async function listE2bSandboxes(
  outputChannel?: vscode.OutputChannel,
): Promise<E2BSandbox[]> {
  const apiKey = getE2bApiKey();
  if (!apiKey) {
    return [];
  }
  try {
    // GET /v2/sandboxes returns the full list as a plain JSON array of
    // { sandboxID, state, ... } objects (pagination is via headers, not a
    // { items } wrapper). Handle the array plus any future wrapper shapes so
    // a shape mismatch never silently yields an empty list.
    const response = await e2bRequest<unknown>("/v2/sandboxes?limit=100", apiKey);
    if (Array.isArray(response)) {
      outputChannel?.appendLine(`[E2B] Listed ${response.length} sandbox(es).`);
      return response as E2BSandbox[];
    }
    const wrapped = response as { sandboxes?: unknown; data?: unknown };
    const items = wrapped.sandboxes ?? wrapped.data;
    if (Array.isArray(items)) {
      outputChannel?.appendLine(
        `[E2B] Listed ${items.length} sandbox(es) (wrapped response).`,
      );
      return items as E2BSandbox[];
    }
    outputChannel?.appendLine(
      "[E2B] Unexpected response shape from GET /v2/sandboxes; no sandboxes found.",
    );
    return [];
  } catch (error) {
    if (outputChannel) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[E2B] Error listing sandboxes: ${message}`);
    }
    return [];
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

    // Make sure the SSH config for this sandbox is up to date so "Connect
    // in..." works right away (best-effort — never fail the resume on errors).
    try {
      ensureE2bSshConfig(sandboxID, outputChannel);
    } catch (ensureErr) {
      const ensureMessage =
        ensureErr instanceof Error ? ensureErr.message : String(ensureErr);
      outputChannel.appendLine(
        `[E2B] Warning: could not refresh SSH config: ${ensureMessage}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[E2B] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to resume E2B sandbox: ${message}`);
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
    ensureE2bSshConfig(sandboxID, outputChannel);
    return hostAlias;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[E2B] Error: ${message}`);
    vscode.window.showErrorMessage(`E2B SSH Error: ${message}`);
    return undefined;
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

function buildE2bBlock(sandboxID: string): string {
  return (
    `Host ${getE2bHostAlias(sandboxID)}\n` +
    `    ProxyCommand websocat --binary -B 65536 - wss://8081-${sandboxID}.e2b.app\n` +
    `    HostName ${sandboxID}\n` +
    "    User user\n"
  );
}

/** Ensures ~/.ssh/e2b.conf holds the correct entry for this sandbox. Writes it
 * only when the file is missing or differs from what we would generate (the
 * E2B config is fully deterministic, so no API call is needed to check).
 * Returns the SSH host alias. */
export function ensureE2bSshConfig(
  sandboxID: string,
  outputChannel: vscode.OutputChannel,
): string {
  const alias = getE2bHostAlias(sandboxID);
  const configPath = path.join(os.homedir(), ".ssh", "e2b.conf");
  const expected = buildE2bBlock(sandboxID);
  try {
    const existing = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : "";
    if (existing.trim() === expected.trim()) {
      outputChannel.appendLine(
        `[E2B] SSH config already up to date (Host: ${alias}).`,
      );
      return alias;
    }
  } catch {
    // Fall through and rewrite.
  }
  writeE2bConfig(sandboxID, outputChannel);
  return alias;
}

function writeE2bConfig(
  sandboxID: string,
  outputChannel: vscode.OutputChannel,
): string {
  const sshDir = path.join(os.homedir(), ".ssh");
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  const configContent = buildE2bBlock(sandboxID);
  const configPath = path.join(sshDir, "e2b.conf");

  fs.writeFileSync(configPath, configContent, { mode: 0o600 });
  outputChannel.appendLine(`[E2B] Config:\n${configContent}`);
  outputChannel.appendLine("[E2B] Ensure ~/.ssh/config contains:");
  outputChannel.appendLine(`Include "${configPath}"`);

  return configPath;
}
