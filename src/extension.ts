import * as vscode from "vscode";
import {
  registerE2bCommands,
  connectE2bSandbox,
  setE2bApiKey,
} from "./services/e2b";
import {
  registerDaytonaCommands,
  connectDaytonaSandbox,
  setDaytonaApiKey,
} from "./services/daytona";
import {
  createDevbox,
  selectDevboxAndSaveSSH,
  suspendDevbox,
  resumeDevbox,
  snapshotDevbox,
  listSnapshots,
  setApiKey,
  connectToDevbox,
} from "./services/runloop/runloopService";
import {
  SandboxProvider,
  E2BSandboxItem,
  DaytonaSandboxItem,
  RunloopDevboxItem,
  SandboxTreeItem,
} from "./providers/SandboxProvider";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Remote Sandbox");
  outputChannel.appendLine("Remote Sandbox is now active!");

  // Initialize Tree View
  const provider = new SandboxProvider(context, outputChannel);
  const treeView = vscode.window.createTreeView(
    "remote-sandbox-sandboxes-sidebar",
    {
      treeDataProvider: provider,
    },
  );
  outputChannel.appendLine("View registered: remote-sandbox-sandboxes-sidebar");

  // E2B + Daytona services
  registerE2bCommands(context, outputChannel);
  registerDaytonaCommands(context, outputChannel);

  // E2B + Daytona API key commands (Runloop-style)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.e2bSetApiKey",
      () => setE2bApiKey(context),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.daytonaSetApiKey",
      () => setDaytonaApiKey(context),
    ),
  );

  // Runloop service
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.runloopCreateDevbox",
      () => createDevbox(context),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopSelectDevboxAndSaveSSH",
      () => selectDevboxAndSaveSSH(context),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopSuspendDevbox",
      (item: RunloopDevboxItem) =>
        suspendDevbox(context, item instanceof RunloopDevboxItem ? item.devbox : undefined),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopResumeDevbox",
      (item: RunloopDevboxItem) =>
        resumeDevbox(context, item instanceof RunloopDevboxItem ? item.devbox : undefined),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopSnapshotDevbox",
      (item: RunloopDevboxItem) =>
        snapshotDevbox(context, item instanceof RunloopDevboxItem ? item.devbox : undefined),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopListSnapshots",
      () => listSnapshots(context),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopSetApiKey",
      () => setApiKey(context),
    ),
  );

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.refreshSandboxes",
      () => provider.refresh(),
    ),
  );

  // Connect actions (invoked from tree item context menus)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.connectInCurrentWindow",
      (item: SandboxTreeItem) => connectToSandbox(item, false),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.connectInNewWindow",
      (item: SandboxTreeItem) => connectToSandbox(item, true),
    ),
  );

  async function connectToSandbox(
    item: SandboxTreeItem | undefined,
    newWindow: boolean,
  ): Promise<void> {
    if (!item) {
      return;
    }

    let hostAlias: string | undefined;
    if (item instanceof E2BSandboxItem) {
      hostAlias = await connectE2bSandbox(item.sandboxID, outputChannel);
    } else if (item instanceof DaytonaSandboxItem) {
      hostAlias = await connectDaytonaSandbox(item.sandboxId, outputChannel);
    } else if (item instanceof RunloopDevboxItem) {
      hostAlias = await connectToDevbox(item.devbox, context, outputChannel);
    }

    if (hostAlias) {
      openRemoteWindow(hostAlias, newWindow, outputChannel);
    }
  }

  context.subscriptions.push(outputChannel, treeView);
}

function openRemoteWindow(
  hostAlias: string,
  newWindow: boolean,
  outputChannel: vscode.OutputChannel,
): void {
  const commandId = newWindow
    ? "opensshremotes.openEmptyWindow"
    : "opensshremotes.openEmptyWindowInCurrentWindow";
  vscode.commands.executeCommand(commandId, { host: hostAlias }).then(
    () => {
      outputChannel.appendLine(
        `[Remote-SSH] Opened ${hostAlias} in ${newWindow ? "new" : "current"} window.`,
      );
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Remote-SSH] Failed to open ${hostAlias}: ${message}`);
      vscode.window.showErrorMessage(
        `Could not open ${hostAlias} via Remote-SSH. Please connect manually.`,
      );
    },
  );
}

export function deactivate(): void {
  // nothing to clean up
}
