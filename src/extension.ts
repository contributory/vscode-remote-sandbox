import * as vscode from "vscode";
import {
  connectE2bSandbox,
  listE2bSandboxes,
  setE2bApiKey,
  pauseE2bSandbox,
  resumeE2bSandbox,
  createE2bSandbox,
  deleteE2bSandbox,
} from "./services/e2b";
import {
  connectDaytonaSandbox,
  listDaytonaSandboxes,
  setDaytonaApiKey,
  stopDaytonaSandbox,
  startDaytonaSandbox,
  createDaytonaSandbox,
  deleteDaytonaSandbox,
} from "./services/daytona";
import {
  createDevbox,
  suspendDevbox,
  resumeDevbox,
  shutdownDevbox,
  snapshotDevbox,
  listDevboxes,
  listSnapshots,
  setApiKey,
  connectToDevbox,
} from "./services/runloop/runloopService";
import {
  SandboxProvider,
  E2BSandboxItem,
  DaytonaSandboxItem,
  RunloopDevboxItem,
  FreestyleSandboxItem,
  SandboxTreeItem,
} from "./providers/SandboxProvider";
import {
  hasFreestyleApiKey,
  listFreestyleVms,
  setFreestyleApiKey,
  createFreestyleVm,
  suspendFreestyleVm,
  startFreestyleVm,
  deleteFreestyleVm,
  connectFreestyleVm,
} from "./services/freestyle";

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

  // E2B sandbox lifecycle (pause / resume / create / delete)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.e2bPauseSandbox",
      async (item: E2BSandboxItem) => {
        if (!(item instanceof E2BSandboxItem)) {
          return;
        }
        await pauseE2bSandbox(item.sandboxID, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.e2bResumeSandbox",
      async (item: E2BSandboxItem) => {
        if (!(item instanceof E2BSandboxItem)) {
          return;
        }
        await resumeE2bSandbox(item.sandboxID, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.e2bCreateSandbox",
      async () => {
        await createE2bSandbox(outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.e2bDeleteSandbox",
      async (item: E2BSandboxItem) => {
        if (!(item instanceof E2BSandboxItem)) {
          return;
        }
        await deleteE2bSandbox(item.sandboxID, outputChannel);
        provider.refresh();
      },
    ),
  );

  // Daytona sandbox lifecycle (stop / start / create / delete)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.daytonaStopSandbox",
      async (item: DaytonaSandboxItem) => {
        if (!(item instanceof DaytonaSandboxItem)) {
          return;
        }
        await stopDaytonaSandbox(item.sandboxId, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.daytonaStartSandbox",
      async (item: DaytonaSandboxItem) => {
        if (!(item instanceof DaytonaSandboxItem)) {
          return;
        }
        await startDaytonaSandbox(item.sandboxId, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.daytonaCreateSandbox",
      async () => {
        await createDaytonaSandbox(outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.daytonaDeleteSandbox",
      async (item: DaytonaSandboxItem) => {
        if (!(item instanceof DaytonaSandboxItem)) {
          return;
        }
        await deleteDaytonaSandbox(item.sandboxId, outputChannel);
        provider.refresh();
      },
    ),
  );

  // Runloop service
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.runloopCreateDevbox",
      async () => {
        await createDevbox(context);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopSuspendDevbox",
      async (item: RunloopDevboxItem) => {
        await suspendDevbox(
          context,
          item instanceof RunloopDevboxItem ? item.devbox : undefined,
        );
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopResumeDevbox",
      async (item: RunloopDevboxItem) => {
        await resumeDevbox(
          context,
          outputChannel,
          item instanceof RunloopDevboxItem ? item.devbox : undefined,
        );
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopShutdownDevbox",
      async (item: RunloopDevboxItem) => {
        await shutdownDevbox(
          context,
          item instanceof RunloopDevboxItem ? item.devbox : undefined,
        );
        provider.refresh();
      },
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

  // Freestyle service
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.freestyleSetApiKey",
      () => setFreestyleApiKey(),
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.freestyleCreateVm",
      async () => {
        await createFreestyleVm(outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.freestyleSuspendVm",
      async (item: FreestyleSandboxItem) => {
        if (!(item instanceof FreestyleSandboxItem)) {
          return;
        }
        await suspendFreestyleVm(item.vm.id, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.freestyleStartVm",
      async (item: FreestyleSandboxItem) => {
        if (!(item instanceof FreestyleSandboxItem)) {
          return;
        }
        await startFreestyleVm(item.vm.id, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.freestyleResumeVm",
      async (item: FreestyleSandboxItem) => {
        if (!(item instanceof FreestyleSandboxItem)) {
          return;
        }
        await startFreestyleVm(item.vm.id, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.freestyleDeleteVm",
      async (item: FreestyleSandboxItem) => {
        if (!(item instanceof FreestyleSandboxItem)) {
          return;
        }
        await deleteFreestyleVm(item.vm.id, outputChannel);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.freestyleListVms",
      async () => {
        const vms = await listFreestyleVms(outputChannel);
        if (vms.length === 0) {
          vscode.window.showInformationMessage("No Freestyle VMs found.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          vms.map((v) => ({
            label: v.id,
            description: v.state,
            detail: `${v.cpu ?? "?"} vCPU · ${v.memory ?? "?"} GiB RAM · ${v.storage ?? "?"} GiB disk`,
            vm: v,
          })),
          {
            placeHolder: "Select a Freestyle VM to connect to",
            matchOnDescription: true,
          },
        );
        if (!pick) {
          return;
        }
        const hostAlias = await connectFreestyleVm(pick.vm, outputChannel);
        if (hostAlias) {
          openRemoteWindow(hostAlias, false, outputChannel);
        }
      },
    ),
  );

  // List sandboxes / devboxes (command palette, QuickPick → connect)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "remote-sandbox.e2bListSandboxes",
      async () => {
        const sandboxes = await listE2bSandboxes(outputChannel);
        if (sandboxes.length === 0) {
          vscode.window.showInformationMessage("No E2B sandboxes found.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          sandboxes.map((s) => ({
            label: s.sandboxID,
            description: s.state ?? "unknown",
          })),
          {
            placeHolder: "Select an E2B sandbox to connect to",
            matchOnDescription: true,
          },
        );
        if (!pick) {
          return;
        }
        const hostAlias = await connectE2bSandbox(pick.label, outputChannel);
        if (hostAlias) {
          openRemoteWindow(hostAlias, false, outputChannel);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.daytonaListSandboxes",
      async () => {
        const sandboxes = await listDaytonaSandboxes(outputChannel);
        if (sandboxes.length === 0) {
          vscode.window.showInformationMessage("No Daytona sandboxes found.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          sandboxes.map((s) => ({
            label: s.name || s.id,
            description: s.state ?? "unknown",
            detail: s.id,
            sandboxId: s.id,
          })),
          {
            placeHolder: "Select a Daytona sandbox to connect to",
            matchOnDescription: true,
          },
        );
        if (!pick) {
          return;
        }
        const hostAlias = await connectDaytonaSandbox(pick.sandboxId, outputChannel);
        if (hostAlias) {
          openRemoteWindow(hostAlias, false, outputChannel);
        }
      },
    ),
    vscode.commands.registerCommand(
      "remote-sandbox.runloopListDevboxes",
      async () => {
        const devboxes = await listDevboxes(context);
        if (devboxes.length === 0) {
          vscode.window.showInformationMessage("No Runloop devboxes found.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          devboxes.map((d) => ({
            label: d.name || d.id,
            description: d.status,
            detail: d.id,
            devbox: d,
          })),
          {
            placeHolder: "Select a Runloop devbox to connect to",
            matchOnDescription: true,
          },
        );
        if (!pick) {
          return;
        }
        const hostAlias = await connectToDevbox(pick.devbox, context, outputChannel);
        if (hostAlias) {
          openRemoteWindow(hostAlias, false, outputChannel);
        }
      },
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
    } else if (item instanceof FreestyleSandboxItem) {
      hostAlias = await connectFreestyleVm(item.vm, outputChannel);
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
