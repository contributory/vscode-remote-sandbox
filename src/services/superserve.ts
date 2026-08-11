import * as vscode from "vscode";

const SUPERSEVE_API_BASE = "https://api.superserve.ai";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface SuperserveSandbox {
  id: string;
  name: string;
  status: "active" | "paused" | "resuming";
  vcpu_count?: number;
  memory_mib?: number;
  snapshot_id?: string;
  created_at?: string;
  timeout_seconds?: number;
  auto_delete_seconds?: number;
  auto_delete_at?: string;
  metadata?: Record<string, string>;
  preview_access?: string;
}

export interface SuperserveTemplate {
  id: string;
  name: string;
  status: string;
  vcpu?: number;
  memory_mib?: number;
  disk_mib?: number;
  size_bytes?: number;
  error_message?: string;
  created_at?: string;
  built_at?: string;
}

/* ------------------------------------------------------------------ */
/* API key handling                                                   */
/* ------------------------------------------------------------------ */

export function getSuperserveApiKey(): string | undefined {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const apiKey = config.get<string>("superserveApiKey");
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey.trim();
  }
  const env = process.env["SUPERSERVE_API_KEY"];
  if (env && env.trim().length > 0) {
    return env.trim();
  }
  return undefined;
}

export function hasSuperserveApiKey(): boolean {
  return getSuperserveApiKey() !== undefined;
}

/** Prompts for and saves the Superserve API key to settings. */
export async function setSuperserveApiKey(): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your Superserve API key",
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
    .update("superserveApiKey", trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("Superserve API key saved to settings.");
}

function promptApiKey(): void {
  vscode.window
    .showWarningMessage(
      "No Superserve API key found. Please provide one, set the remoteSandbox.superserveApiKey setting, or set the SUPERSERVE_API_KEY environment variable.",
      "Set API Key",
    )
    .then((selection) => {
      if (selection === "Set API Key") {
        vscode.commands.executeCommand("remote-sandbox.superserveSetApiKey");
      }
    });
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                        */
/* ------------------------------------------------------------------ */

async function superserveRequest<T>(
  requestPath: string,
  apiKey: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(`${SUPERSEVE_API_BASE}${requestPath}`, {
    method,
    headers: {
      "X-API-Key": apiKey,
      ...(requestBody ? { "Content-Type": "application/json" } : {}),
    },
    body: requestBody,
  });

  const text = await response.text();
  if (!response.ok) {
    let message = text.trim() || response.statusText || "Unknown error";
    try {
      const err = JSON.parse(text) as { error?: { message?: string } };
      message = err.error?.message ?? message;
    } catch {
      // use response body as-is
    }
    throw new Error(
      `Superserve API request failed (${response.status}): ${message}`,
    );
  }
  if (!text.trim()) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ */
/* List sandboxes                                                     */
/* ------------------------------------------------------------------ */

/** Lists Superserve sandboxes visible to the configured API key. Returns []
 * when the API key is missing or the request fails. */
export async function listSuperserveSandboxes(
  outputChannel?: vscode.OutputChannel,
): Promise<SuperserveSandbox[]> {
  const apiKey = getSuperserveApiKey();
  if (!apiKey) {
    return [];
  }
  try {
    const sandboxes = await superserveRequest<SuperserveSandbox[]>(
      "/sandboxes",
      apiKey,
    );
    outputChannel?.appendLine(`[Superserve] Listed ${sandboxes.length} sandbox(es).`);
    return sandboxes;
  } catch (error) {
    if (outputChannel) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Superserve] Error listing sandboxes: ${message}`);
    }
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* List templates                                                     */
/* ------------------------------------------------------------------ */

async function listTemplates(
  apiKey: string,
): Promise<SuperserveTemplate[]> {
  try {
    return await superserveRequest<SuperserveTemplate[]>("/templates", apiKey);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Create sandbox                                                     */
/* ------------------------------------------------------------------ */

/** Creates a new Superserve sandbox with full configuration.
 * API: POST /sandboxes */
export async function createSuperserveSandbox(
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getSuperserveApiKey();
  if (!apiKey) {
    promptApiKey();
    return undefined;
  }

  try {
    // Step 1: name (required)
    const name = await vscode.window.showInputBox({
      prompt: "Superserve sandbox name (required)",
      placeHolder: "my-sandbox",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length > 0 ? null : "Name is required"),
    });
    if (!name) {
      return undefined;
    }

    // Step 2: template selection
    const templates = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Fetching Superserve templates...",
        cancellable: false,
      },
      () => listTemplates(apiKey),
    );

    let fromTemplate: string | undefined;
    if (templates.length > 0) {
      const pick = await vscode.window.showQuickPick(
        templates
          .filter((t) => t.status === "ready")
          .map((t) => ({
            label: t.name,
            description: t.id,
            detail: `${t.vcpu ?? "?"} vCPU · ${t.memory_mib ?? "?"} MiB RAM · ${t.disk_mib ?? "?"} MiB disk`,
            id: t.id,
          })),
        {
          placeHolder:
            "Select a template (or skip for superserve/base default)",
          ignoreFocusOut: true,
        },
      );
      fromTemplate = pick?.id;
    } else {
      const manual = await vscode.window.showInputBox({
        prompt:
          "Template name or ID (optional, empty for superserve/base default)",
        placeHolder: "superserve/base",
        ignoreFocusOut: true,
      });
      if (manual === undefined) {
        return undefined;
      }
      if (manual.trim()) {
        fromTemplate = manual.trim();
      }
    }

    // Step 3: timeout seconds
    const timeoutStr = await vscode.window.showInputBox({
      prompt:
        "Auto-pause timeout in seconds (optional, empty = never auto-pause)",
      placeHolder: "3600",
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return null;
        const n = parseInt(v, 10);
        return isNaN(n) || n < 1 ? "Must be a positive number" : null;
      },
    });
    if (timeoutStr === undefined) {
      return undefined;
    }
    const timeoutSeconds = timeoutStr.trim()
      ? parseInt(timeoutStr, 10)
      : undefined;

    // Step 4: auto-delete seconds
    const deleteStr = await vscode.window.showInputBox({
      prompt:
        "Auto-delete after N seconds paused (optional, 0 = delete immediately on pause)",
      placeHolder: "86400",
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return null;
        const n = parseInt(v, 10);
        return isNaN(n) || n < 0 ? "Must be a non-negative integer" : null;
      },
    });
    if (deleteStr === undefined) {
      return undefined;
    }
    const autoDeleteSeconds = deleteStr.trim()
      ? parseInt(deleteStr, 10)
      : undefined;

    // Build the request body
    const body: Record<string, unknown> = { name: name.trim() };
    if (fromTemplate) {
      body.from_template = fromTemplate;
    }
    if (timeoutSeconds !== undefined) {
      body.timeout_seconds = timeoutSeconds;
    }
    if (autoDeleteSeconds !== undefined) {
      body.auto_delete_seconds = autoDeleteSeconds;
    }

    const sandbox = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Creating Superserve sandbox...",
        cancellable: false,
      },
      () => superserveRequest<SuperserveSandbox>("/sandboxes", apiKey, "POST", body),
    );

    outputChannel.appendLine(
      `[Superserve] Created sandbox: ${sandbox.name} (${sandbox.id})`,
    );
    vscode.window.showInformationMessage(
      `Superserve sandbox created: ${sandbox.name} (${sandbox.id})`,
    );
    return sandbox.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Superserve] Error creating sandbox: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to create Superserve sandbox: ${message}`,
    );
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Pause / Resume / Delete / Connect                                  */
/* ------------------------------------------------------------------ */

/** Pauses an active Superserve sandbox. API: POST /sandboxes/{id}/pause */
export async function pauseSuperserveSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getSuperserveApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pausing Superserve sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        superserveRequest<void>(
          `/sandboxes/${encodeURIComponent(sandboxId)}/pause`,
          apiKey,
          "POST",
        ),
    );
    outputChannel.appendLine(`[Superserve] Paused sandbox: ${sandboxId}`);
    vscode.window.showInformationMessage(
      `Superserve sandbox paused: ${sandboxId}. Resume it to continue.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Superserve] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to pause Superserve sandbox: ${message}`,
    );
  }
}

/** Resumes a paused Superserve sandbox. API: POST /sandboxes/{id}/resume */
export async function resumeSuperserveSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getSuperserveApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Resuming Superserve sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        superserveRequest<void>(
          `/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
          apiKey,
          "POST",
        ),
    );
    outputChannel.appendLine(`[Superserve] Resumed sandbox: ${sandboxId}`);
    vscode.window.showInformationMessage(
      `Superserve sandbox resumed: ${sandboxId}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Superserve] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to resume Superserve sandbox: ${message}`,
    );
  }
}

/** Deletes a Superserve sandbox permanently. API: DELETE /sandboxes/{id} */
export async function deleteSuperserveSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getSuperserveApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    const confirm = await vscode.window.showWarningMessage(
      `Delete Superserve sandbox ${sandboxId}? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting Superserve sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        superserveRequest<void>(
          `/sandboxes/${encodeURIComponent(sandboxId)}`,
          apiKey,
          "DELETE",
        ),
    );
    outputChannel.appendLine(`[Superserve] Deleted sandbox: ${sandboxId}`);
    vscode.window.showInformationMessage(
      `Superserve sandbox deleted: ${sandboxId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Superserve] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to delete Superserve sandbox: ${message}`,
    );
  }
}

/**
 * "Connects" to a Superserve sandbox by activating it (auto-resumes if
 * paused, returns access token). Since Superserve doesn't use SSH, we
 * show a notification with the sandbox info instead of opening Remote-SSH.
 */
export async function activateSuperserveSandbox(
  sandbox: SuperserveSandbox,
  outputChannel: vscode.OutputChannel,
): Promise<SuperserveSandbox | undefined> {
  const apiKey = getSuperserveApiKey();
  if (!apiKey) {
    outputChannel.appendLine("[Superserve] API key is not configured.");
    promptApiKey();
    return undefined;
  }

  try {
    outputChannel.show(true);

    // Auto-resume if paused via activate
    const updated = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Activating Superserve sandbox ${sandbox.name || sandbox.id}...`,
        cancellable: false,
      },
      () =>
        superserveRequest<SuperserveSandbox>(
          `/sandboxes/${encodeURIComponent(sandbox.id)}/activate`,
          apiKey,
          "POST",
        ),
    );

    outputChannel.appendLine(
      `[Superserve] Activated sandbox: ${updated.name} (${updated.id}) — status: ${updated.status}`,
    );
    vscode.window.showInformationMessage(
      `Superserve sandbox activated: ${updated.name} (${updated.id}). Ready to use.`,
    );
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Superserve] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to activate Superserve sandbox: ${message}`,
    );
    return undefined;
  }
}