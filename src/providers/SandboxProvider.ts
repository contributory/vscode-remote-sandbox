import * as vscode from "vscode";
import type { SandboxProviderId } from "../models/types";
import { hasE2bApiKey, listE2bSandboxes } from "../services/e2b";
import { hasDaytonaApiKey, listDaytonaSandboxes } from "../services/daytona";
import { hasRunloopApiKey, listDevboxes } from "../services/runloop/runloopService";
import type { Devbox } from "../services/runloop/runloopApi";

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
    this.contextValue = "e2bSandbox";
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
    this.contextValue = "daytonaSandbox";
    this.tooltip = `Daytona sandbox: ${sandboxId}`;
  }
}

export class RunloopDevboxItem extends vscode.TreeItem {
  constructor(public readonly devbox: Devbox) {
    super(devbox.name || devbox.id, vscode.TreeItemCollapsibleState.None);
    this.description = devbox.status;
    this.iconPath = new vscode.ThemeIcon("package");
    this.contextValue = "runloopDevbox";
    this.tooltip = `Runloop devbox: ${devbox.id}`;
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
      }
    }

    return [];
  }

  private async getE2bChildren(): Promise<SandboxTreeItem[]> {
    if (!hasE2bApiKey()) {
      return [
        new ActionItem("Set E2B API key...", "remote-sandbox.e2bSetApiKey", "key"),
      ];
    }
    const sandboxes = await listE2bSandboxes();
    if (sandboxes.length === 0) {
      return [new ActionItem("No E2B sandboxes found", undefined, "info")];
    }
    return sandboxes.map((s) => new E2BSandboxItem(s.sandboxID, s.state));
  }

  private async getDaytonaChildren(): Promise<SandboxTreeItem[]> {
    if (!hasDaytonaApiKey()) {
      return [
        new ActionItem(
          "Set Daytona API key...",
          "remote-sandbox.daytonaSetApiKey",
          "key",
        ),
      ];
    }
    const sandboxes = await listDaytonaSandboxes();
    if (sandboxes.length === 0) {
      return [new ActionItem("No Daytona sandboxes found", undefined, "info")];
    }
    return sandboxes.map((s) => new DaytonaSandboxItem(s.id, s.name, s.state));
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
}
