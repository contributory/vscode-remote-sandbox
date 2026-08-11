import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const FREESTYLE_API_BASE = "https://api.freestyle.sh";
const FREESTYLE_SSH_HOST = "vm-ssh.freestyle.sh";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface FreestyleVM {
  id: string;
  status: "running" | "stopped" | "starting" | "stopping" | "error";
  name?: string;
  cpu?: number;
  memory?: number;
  storage?: number;
  createdAt?: string;
}

export interface FreestyleIdentity {
  id: string;
}

export interface FreestyleToken {
  token: string;
}

/* ------------------------------------------------------------------ */
/* API key handling                                                   */
/* ------------------------------------------------------------------ */

export function getFreestyleApiKey(): string | undefined {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const apiKey = config.get<string>("freestyleApiKey");
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey.trim();
  }
  const env = process.env["FREESTYLE_API_KEY"];
  if (env && env.trim().length > 0) {
    return env.trim();
  }
  return undefined;
}

export function hasFreestyleApiKey(): boolean {
  return getFreestyleApiKey() !== undefined;
}

export async function setFreestyleApiKey(): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your Freestyle API key",
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
    .update("freestyleApiKey", trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("Freestyle API key saved to settings.");
}

function promptApiKey(): void {
  vscode.window
    .showWarningMessage(
      "No Freestyle API key found. Please provide one, set the remoteSandbox.freestyleApiKey setting, or set the FREESTYLE_API_KEY environment variable.",
      "Set API Key",
    )
    .then((selection) => {
      if (selection === "Set API Key") {
        vscode.commands.executeCommand("remote-sandbox.freestyleSetApiKey");
      }
    });
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                        */
/* ------------------------------------------------------------------ */

async function freestyleRequest<T>(
  requestPath: string,
  apiKey: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(`${FREESTYLE_API_BASE}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(requestBody ? { "Content-Type": "application/json" } : {}),
    },
    body: requestBody,
  });

  const text = await response.text();
  if (!response.ok) {
    let message = text.trim() || response.statusText || "Unknown error";
    try {
      const err = JSON.parse(text) as { error?: { message?: string }; message?: string };
      message = err.error?.message ?? err.message ?? message;
    } catch {
      // use response body as-is
    }
    throw new Error(
      `Freestyle API request failed (${response.status}): ${message}`,
    );
  }
  if (!text.trim()) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ */
/* List VMs                                                           */
/* ------------------------------------------------------------------ */

/** Lists Freestyle VMs visible to the configured API key. Returns []
 * when the API key is missing or the request fails. */
export async function listFreestyleVms(
  outputChannel?: vscode.OutputChannel,
): Promise<FreestyleVM[]> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    return [];
  }
  try {
    const vms = await freestyleRequest<FreestyleVM[]>("/v1/vms", apiKey);
    outputChannel?.appendLine(`[Freestyle] Listed ${vms.length} VM(s).`);
    return vms;
  } catch (error) {
    if (outputChannel) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Freestyle] Error listing VMs: ${message}`);
    }
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Create VM                                                          */
/* ------------------------------------------------------------------ */

interface CreateVMOptions {
  cpu?: number;
  memory?: number;
  storage?: number;
  idleTimeoutSeconds?: number;
}

/** Creates a new Freestyle VM with optional configuration.
 * API: POST /v1/vms */
export async function createFreestyleVm(
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return undefined;
  }

  try {
    // Step 1: CPU cores
    const cpuStr = await vscode.window.showInputBox({
      prompt: "CPU cores (optional, powers of 2. Default: 4)",
      placeHolder: "4",
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return null;
        const n = parseInt(v, 10);
        return isNaN(n) || n < 1 ? "Must be a positive integer" : null;
      },
    });
    if (cpuStr === undefined) {
      return undefined;
    }
    const cpu = cpuStr.trim() ? parseInt(cpuStr, 10) : undefined;

    // Step 2: Memory (GB)
    const memStr = await vscode.window.showInputBox({
      prompt: "Memory in GiB (optional, powers of 2. Default: 8)",
      placeHolder: "8",
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return null;
        const n = parseInt(v, 10);
        return isNaN(n) || n < 1 ? "Must be a positive integer" : null;
      },
    });
    if (memStr === undefined) {
      return undefined;
    }
    const memory = memStr.trim() ? parseInt(memStr, 10) : undefined;

    // Step 3: Storage (GB)
    const diskStr = await vscode.window.showInputBox({
      prompt: "Storage in GiB (optional. Default: 20)",
      placeHolder: "20",
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return null;
        const n = parseInt(v, 10);
        return isNaN(n) || n < 1 ? "Must be a positive integer" : null;
      },
    });
    if (diskStr === undefined) {
      return undefined;
    }
    const storage = diskStr.trim() ? parseInt(diskStr, 10) : undefined;

    // Step 4: Idle timeout
    const idleStr = await vscode.window.showInputBox({
      prompt: "Idle timeout in seconds (optional, empty = never)",
      placeHolder: "600",
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return null;
        const n = parseInt(v, 10);
        return isNaN(n) || n < 0 ? "Must be a non-negative integer" : null;
      },
    });
    if (idleStr === undefined) {
      return undefined;
    }
    const idleTimeoutSeconds = idleStr.trim() ? parseInt(idleStr, 10) : undefined;

    // Build request body
    const body: Record<string, unknown> = {};
    if (cpu !== undefined) body.cpu = cpu;
    if (memory !== undefined) body.memory = memory;
    if (storage !== undefined) body.storage = storage;
    if (idleTimeoutSeconds !== undefined) body.idleTimeoutSeconds = idleTimeoutSeconds;

    const vm = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Creating Freestyle VM...",
        cancellable: false,
      },
      () => freestyleRequest<FreestyleVM>("/v1/vms", apiKey, "POST", body),
    );

    outputChannel.appendLine(
      `[Freestyle] Created VM: ${vm.id} (status: ${vm.status})`,
    );
    vscode.window.showInformationMessage(
      `Freestyle VM created: ${vm.id} (${vm.status}). Connect via SSH from the tree view.`,
    );
    return vm.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error creating VM: ${message}`);
    vscode.window.showErrorMessage(`Failed to create Freestyle VM: ${message}`);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Stop / Start / Delete                                              */
/* ------------------------------------------------------------------ */

/** Stops a running Freestyle VM. API: POST /v1/vms/{id}/stop */
export async function stopFreestyleVm(
  vmId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Stopping Freestyle VM ${vmId}...`,
        cancellable: false,
      },
      () => freestyleRequest<void>(`/v1/vms/${encodeURIComponent(vmId)}/stop`, apiKey, "POST"),
    );
    outputChannel.appendLine(`[Freestyle] Stopped VM: ${vmId}`);
    vscode.window.showInformationMessage(
      `Freestyle VM stopped: ${vmId}. Start it again to reconnect.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to stop Freestyle VM: ${message}`);
  }
}

/** Starts a stopped Freestyle VM. API: POST /v1/vms/{id}/start */
export async function startFreestyleVm(
  vmId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting Freestyle VM ${vmId}...`,
        cancellable: false,
      },
      () => freestyleRequest<void>(`/v1/vms/${encodeURIComponent(vmId)}/start`, apiKey, "POST"),
    );
    outputChannel.appendLine(`[Freestyle] Started VM: ${vmId}`);
    vscode.window.showInformationMessage(`Freestyle VM started: ${vmId}.`);

    // Refresh SSH config so "Connect in..." works right away
    try {
      await ensureFreestyleSshConfig(vmId, apiKey, outputChannel);
    } catch (ensureErr) {
      outputChannel.appendLine(
        `[Freestyle] Warning: could not refresh SSH config: ${ensureErr}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to start Freestyle VM: ${message}`);
  }
}

/** Deletes a Freestyle VM permanently. API: DELETE /v1/vms/{id} */
export async function deleteFreestyleVm(
  vmId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    const confirm = await vscode.window.showWarningMessage(
      `Delete Freestyle VM ${vmId}? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting Freestyle VM ${vmId}...`,
        cancellable: false,
      },
      () => freestyleRequest<void>(`/v1/vms/${encodeURIComponent(vmId)}`, apiKey, "DELETE"),
    );
    outputChannel.appendLine(`[Freestyle] Deleted VM: ${vmId}`);
    vscode.window.showInformationMessage(`Freestyle VM deleted: ${vmId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to delete Freestyle VM: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* SSH / Connect                                                      */
/* ------------------------------------------------------------------ */

/** Host alias used for SSH config. */
export function freestyleHostAlias(vmId: string): string {
  return `FS_${vmId}`;
}

/**
 * Creates SSH access for a Freestyle VM by:
 * 1. Creating an identity
 * 2. Granting VM permission to that identity
 * 3. Creating an access token
 * 4. Writing ~/.ssh/freestyle.conf with the proper SSH config
 *
 * Returns the SSH host alias on success, undefined on failure.
 */
async function ensureFreestyleSshConfig(
  vmId: string,
  apiKey: string,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const alias = freestyleHostAlias(vmId);
  const configPath = path.join(os.homedir(), ".ssh", "freestyle.conf");

  try {
    // Step 1: Create identity
    outputChannel.appendLine("[Freestyle] Creating SSH identity...");
    const identity = await freestyleRequest<FreestyleIdentity>(
      "/identity/v1/identities",
      apiKey,
      "POST",
      {},
    );

    // Step 2: Grant VM permission
    outputChannel.appendLine("[Freestyle] Granting VM permission...");
    await freestyleRequest<void>(
      `/identity/v1/identities/${encodeURIComponent(identity.id)}/permissions/vm/${encodeURIComponent(vmId)}`,
      apiKey,
      "POST",
      {},
    );

    // Step 3: Create token
    outputChannel.appendLine("[Freestyle] Creating access token...");
    const tokenResult = await freestyleRequest<FreestyleToken>(
      `/identity/v1/identities/${encodeURIComponent(identity.id)}/tokens`,
      apiKey,
      "POST",
      {},
    );

    // Step 4: Write SSH config
    const sshDir = path.join(os.homedir(), ".ssh");
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });

    const sshUser = "root";
    const username = `${vmId}+${sshUser}`;
    const configContent = [
      `# BEGIN FREESTYLE VM ${alias}`,
      `Host ${alias}`,
      `    HostName ${FREESTYLE_SSH_HOST}`,
      `    User ${username}`,
      `    Port 22`,
      `    StrictHostKeyChecking no`,
      `    UserKnownHostsFile /dev/null`,
      `    ServerAliveInterval 60`,
      `    ServerAliveCountMax 3`,
      `    # Token: ${tokenResult.token}`,
      `# END FREESTYLE VM ${alias}`,
      "",
    ].join("\n");

    // Write to freestyle.conf (replace existing block for this VM)
    let existing = "";
    try {
      existing = fs.readFileSync(configPath, "utf8");
    } catch {
      // file doesn't exist yet
    }

    const beginMarker = `# BEGIN FREESTYLE VM ${alias}`;
    const endMarker = `# END FREESTYLE VM ${alias}`;
    const startIdx = existing.indexOf(beginMarker);
    const endIdx = existing.indexOf(endMarker);

    let next: string;
    if (startIdx >= 0 && endIdx >= 0) {
      next = existing.slice(0, startIdx) + configContent + existing.slice(endIdx + endMarker.length);
    } else {
      next = existing.trimEnd() + (existing.trim() ? "\n\n" : "") + configContent;
    }
    fs.writeFileSync(configPath, next, { mode: 0o600 });

    // Ensure ~/.ssh/config includes freestyle.conf
    const mainConfig = path.join(sshDir, "config");
    const includeLine = `Include ${configPath}`;
    try {
      const mainContent = fs.readFileSync(mainConfig, "utf8");
      if (!mainContent.includes("freestyle.conf")) {
        fs.writeFileSync(
          mainConfig,
          mainContent.trimEnd() + "\n\n" + includeLine + "\n",
          "utf8",
        );
      }
    } catch {
      fs.writeFileSync(mainConfig, includeLine + "\n", "utf8");
    }

    outputChannel.appendLine(
      `[Freestyle] SSH config written to ${configPath} (Host: ${alias})`,
    );
    return alias;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] SSH setup error: ${message}`);
    return undefined;
  }
}

/**
 * Connects to a Freestyle VM by creating SSH credentials and writing the
 * SSH config. Returns the SSH host alias on success, undefined on failure.
 */
export async function connectFreestyleVm(
  vm: FreestyleVM,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    outputChannel.appendLine("[Freestyle] API key is not configured.");
    promptApiKey();
    return undefined;
  }

  try {
    outputChannel.show(true);

    // Auto-start if stopped
    if (vm.status === "stopped" || vm.status === "stopping") {
      outputChannel.appendLine(`[Freestyle] VM ${vm.id} is stopped — starting...`);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting Freestyle VM ${vm.id}...`,
          cancellable: false,
        },
        () =>
          freestyleRequest<void>(
            `/v1/vms/${encodeURIComponent(vm.id)}/start`,
            apiKey,
            "POST",
          ),
      );
    }

    return await ensureFreestyleSshConfig(vm.id, apiKey, outputChannel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to connect to Freestyle VM: ${message}`);
    return undefined;
  }
}