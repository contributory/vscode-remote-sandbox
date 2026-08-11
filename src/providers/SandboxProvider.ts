import * as vscode from "vscode";
import type { SandboxProviderId } from "../models/types";
import { hasE2bApiKey, listE2bSandboxes } from "../services/e2b";
import { hasDaytonaApiKey, listDaytonaSandboxes } from "../services/daytona";
import { hasRunloopApiKey, listDevboxes } from "../services/runloop/runloopService";
import type { Devbox } from "../services/runloop/runloopApi";
import { hasFreestyleApiKey, listFreestyleVms, type FreestyleVM } from "../services/freestyle";

export type SandboxTreeItem = vscode.TreeItem;

class SandboxSectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly provider: SandboxProviderId,
    collapsibleState: vscode.TreeItemCollapsibleState,
    icon: string,
  ) {
    super(label, collapsibleState);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `${provider}Section`;
  }
}

/** A non-interactive / action leaf shown inside a provider section. */
class ActionItem extends vscode.TreeItem {
  constructor(label: string, commandId: string | undefined, icon: string, args?: unknown[]) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    if (commandId) {
      this.command = { command: commandId, title: label, arguments: args };
    }
  }
}

export class E2BSandboxItem extends vscode.TreeItem {
  constructor(
    public readonly sandboxID: string,
    public readonly state?: string,
  ) {
    super(sandboxID, vscode.TreeItemCollapsibleState.None);
    this.description = state ?? "";
    this.iconPath = new vscode.ThemeIcon("server-process");
    // State-aware contextValue so the UI can show "Pause" for running
    // sandboxes and "Resume" for paused ones. All E2B sandboxes get a delete
    // action.
    this.contextValue =
      state === "paused" ? "e2bSandboxPaused" : "e2bSandboxRunning";
    this.tooltip = `E2B sandbox: ${sandboxID}`;
  }
}

export class DaytonaSandboxItem extends vscode.TreeItem {
  constructor(
    public readonly sandboxId: string,
    public readonly name: string | undefined,
    public readonly state?: string,
  ) {
    super(name || sandboxId, vscode.TreeItemCollapsibleState.None);
    this.description = state ?? "";
    this.iconPath = new vscode.ThemeIcon("server");
    // State-aware contextValue so the UI can show "Stop" when started and
    // "Start" when stopped. All Daytona sandboxes get a delete action.
    this.contextValue =
      state === "started" ? "daytonaSandboxStarted" : "daytonaSandboxStopped";
    this.tooltip = `Daytona sandbox: ${sandboxId}`;
  }
}

export class RunloopDevboxItem extends vscode.TreeItem {
  constructor(public readonly devbox: Devbox) {
    super(devbox.name || devbox.id, vscode.TreeItemCollapsibleState.None);
    this.description = devbox.status;
    this.iconPath = new vscode.ThemeIcon("package");
    // State-aware contextValue so the UI can show "Suspend" when running and
    // "Resume" when suspended. All devboxes get a delete (shutdown) action.
    this.contextValue =
      devbox.status === "suspended"
        ? "runloopDevboxSuspended"
        : "runloopDevboxRunning";
    this.tooltip = `Runloop devbox: ${devbox.id}`;
  }
}

export class FreestyleSandboxItem extends vscode.TreeItem {
  constructor(public readonly vm: FreestyleVM) {
    super(vm.id, vscode.TreeItemCollapsibleState.None);
    this.description = vm.status;
    this.iconPath = new vscode.ThemeIcon("vm");
    // State-aware contextValue so the UI can show "Stop" when running and
    // "Start" when stopped.
    this.contextValue =
      vm.status === "running" ? "freestyleVmRunning" : "freestyleVmStopped";
    this.tooltip = `Freestyle VM: ${vm.id}`;
  }
}

/**
 * Tree data provider for the "Sandboxes" view. The root shows one collapsible
 * section per provider (E2B, Daytona, Runloop); each section lazily lists the
 * user's sandboxes / devboxes from the corresponding service.
 */
export class SandboxProvider implements vscode.TreeDataProvider<SandboxTreeItem> {
  private readonly _onDidChangeTreeData: vscode.EventEmitter<SandboxTreeItem | undefined | null | void> =
    new vscode.EventEmitter<SandboxTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SandboxTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SandboxTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SandboxTreeItem): Promise<SandboxTreeItem[]> {
    if (!element) {
      return [
        new SandboxSectionItem(
          "E2B Sandboxes",
          "e2b",
          vscode.TreeItemCollapsibleState.Expanded,
          "server-process",
        ),
        new SandboxSectionItem(
          "Daytona Sandboxes",
          "daytona",
          vscode.TreeItemCollapsibleState.Expanded,
          "server",
        ),
        new SandboxSectionItem(
          "Runloop Devboxes",
          "runloop",
          vscode.TreeItemCollapsibleState.Expanded,
          "package",
        ),
        new SandboxSectionItem(
          "Freestyle VMs",
          "freestyle",
          vscode.TreeItemCollapsibleState.Expanded,
          "vm",
        ),
      ];
    }

    if (element instanceof SandboxSectionItem) {
      switch (element.provider) {
        case "e2b":
          return this.getE2bChildren();
        case "daytona":
          return this.getDaytonaChildren();
        case "runloop":
          return this.getRunloopChildren();
        case "freestyle":
          return this.getFreestyleChildren();
      }
    }

    return [];
  }

  private async getE2bChildren(): Promise<SandboxTreeItem[]> {
    const items: SandboxTreeItem[] = [];
    if (!hasE2bApiKey()) {
      items.push(new ActionItem("Set E2B API key...", "remote-sandbox.e2bSetApiKey", "key"));
      return items;
    }
    const sandboxes = await listE2bSandboxes();
    if (sandboxes.length === 0) {
      items.push(new ActionItem("No E2B sandboxes found", undefined, "info"));
    } else {
      items.push(...sandboxes.map((s) => new E2BSandboxItem(s.sandboxID, s.state)));
    }
    return items;
  }

  private async getDaytonaChildren(): Promise<SandboxTreeItem[]> {
    const items: SandboxTreeItem[] = [];
    if (!hasDaytonaApiKey()) {
      items.push(new ActionItem(
        "Set Daytona API key...",
        "remote-sandbox.daytonaSetApiKey",
        "key",
      ));
      return items;
    }
    const sandboxes = await listDaytonaSandboxes();
    if (sandboxes.length === 0) {
      items.push(new ActionItem("No Daytona sandboxes found", undefined, "info"));
    } else {
      items.push(...sandboxes.map((s) => new DaytonaSandboxItem(s.id, s.name, s.state)));
    }
    return items;
  }

  private async getRunloopChildren(): Promise<SandboxTreeItem[]> {
    if (!hasRunloopApiKey()) {
      return [
        new ActionItem("Set Runloop API key...", "remote-sandbox.runloopSetApiKey", "key"),
      ];
    }
    const devboxes = await listDevboxes(this.context);
    if (devboxes.length === 0) {
      return [
        new ActionItem("No Runloop devboxes found", "remote-sandbox.runloopCreateDevbox", "add"),
      ];
    }
    return devboxes.map((d) => new RunloopDevboxItem(d));
  }

  private async getFreestyleChildren(): Promise<SandboxTreeItem[]> {
    const items: SandboxTreeItem[] = [];
    if (!hasFreestyleApiKey()) {
      items.push(new ActionItem("Set Freestyle API key...", "remote-sandbox.freestyleSetApiKey", "key"));
      return items;
    }
    const vms = await listFreestyleVms();
    if (vms.length === 0) {
      items.push(new ActionItem("No Freestyle VMs found", undefined, "info"));
    } else {
      items.push(...vms.map((v) => new FreestyleSandboxItem(v)));
    }
    return items;
  }
}
