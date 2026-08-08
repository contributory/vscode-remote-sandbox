import * as vscode from 'vscode';
import { RunloopApi, RunloopApiError, type Devbox, type DiskSnapshot } from './runloopApi';
import {
  buildSshBlock,
  ensureIncludeLine,
  getSshConfigPath,
  hostAliasFor,
  writePrivateKey,
  writeSshConfig,
} from './sshConfig';

const API_KEY_SECRET_KEY = 'remoteSandbox.runloopApiKey';

const RESOURCE_SIZES: { label: string; description: string }[] = [
  { label: 'Default (SMALL)', description: '1 vCPU · 2 GiB RAM · 4 GiB disk' },
  { label: 'X_SMALL', description: '0.5 vCPU · 1 GiB RAM · 4 GiB disk' },
  { label: 'SMALL', description: '1 vCPU · 2 GiB RAM · 4 GiB disk' },
  { label: 'MEDIUM', description: '2 vCPU · 4 GiB RAM · 8 GiB disk' },
  { label: 'LARGE', description: '2 vCPU · 8 GiB RAM · 16 GiB disk' },
  { label: 'X_LARGE', description: '4 vCPU · 16 GiB RAM · 16 GiB disk' },
  { label: 'XX_LARGE', description: '8 vCPU · 32 GiB RAM · 16 GiB disk' },
];

// Runloop caps keep_alive_time_seconds at 172800s (48h), so the closest
// thing to "never shutdown" is the maximum value.
const KEEP_ALIVE_OPTIONS: { label: string; description: string; seconds: number | undefined }[] = [
  { label: 'Never shutdown (48h max)', description: 'keep_alive_time_seconds = 172800 (maximum allowed)', seconds: 172800 },
  { label: '1 hour (platform default)', description: 'keep_alive_time_seconds = 3600', seconds: 3600 },
  { label: '6 hours', description: 'keep_alive_time_seconds = 21600', seconds: 21600 },
  { label: '12 hours', description: 'keep_alive_time_seconds = 43200', seconds: 43200 },
  { label: '24 hours', description: 'keep_alive_time_seconds = 86400', seconds: 86400 },
  { label: '48 hours', description: 'keep_alive_time_seconds = 172800', seconds: 172800 },
];

/* ------------------------------------------------------------------ */
/* API key handling                                                    */
/* ------------------------------------------------------------------ */

export function hasRunloopApiKey(): boolean {
  const config = vscode.workspace.getConfiguration('remoteSandbox').get<string>('runloopApiKey');
  if (config && config.trim()) {
    return true;
  }
  const env = process.env['RUNLOOP_API_KEY'];
  return !!(env && env.trim());
}

/**
 * Resolve the API key from (in order): the `remoteSandbox.runloopApiKey`
 * setting, the stored secret, or the `RUNLOOP_API_KEY` environment variable.
 * When `quiet` is true, no prompt is shown if the key is missing.
 */
async function getApiKey(
  context: vscode.ExtensionContext,
  quiet = false,
): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration('remoteSandbox').get<string>('runloopApiKey');
  if (config && config.trim()) {
    return config.trim();
  }
  const stored = await context.secrets.get(API_KEY_SECRET_KEY);
  if (stored && stored.trim()) {
    return stored.trim();
  }
  const env = process.env['RUNLOOP_API_KEY'];
  if (env && env.trim()) {
    return env.trim();
  }
  if (quiet) {
    return undefined;
  }
  const choice = await vscode.window.showWarningMessage(
    'No Runloop API key found. Please provide one, set the remoteSandbox.runloopApiKey setting, or set the RUNLOOP_API_KEY environment variable.',
    'Set API Key',
    'Cancel'
  );
  if (choice === 'Set API Key') {
    await setApiKey(context);
  } else {
    throw new Error('Runloop API key is required.');
  }
  return getApiKey(context, true);
}

export async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your Runloop API key',
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    vscode.window.showErrorMessage('API key cannot be empty.');
    return;
  }
  await vscode.workspace
    .getConfiguration('remoteSandbox')
    .update('runloopApiKey', trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage('Runloop API key saved to settings.');
}

async function requireApi(context: vscode.ExtensionContext): Promise<RunloopApi> {
  const key = await getApiKey(context, false);
  if (!key) {
    throw new Error('Runloop API key is required.');
  }
  return new RunloopApi(key);
}

/* ------------------------------------------------------------------ */
/* Command: Create a devbox                                            */
/* ------------------------------------------------------------------ */

export async function createDevbox(
  context: vscode.ExtensionContext,
  initialSnapshotId?: string
): Promise<void> {
  try {
    const api = await requireApi(context);

    const name = await vscode.window.showInputBox({
      prompt: 'Devbox name (optional)',
      placeHolder: 'my-devbox',
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return;
    }

    const size = await vscode.window.showQuickPick(RESOURCE_SIZES, {
      placeHolder: 'Select resource size (optional)',
      ignoreFocusOut: true,
    });
    if (size === undefined) {
      return;
    }
    // 'Default (SMALL)' maps to no explicit resource size (API default = SMALL)
    const resourceSize = size.label === 'Default (SMALL)' ? undefined : size.label;

    const keepAlive = await vscode.window.showQuickPick(KEEP_ALIVE_OPTIONS, {
      placeHolder: 'Keep-alive / auto-shutdown? (Never shutdown = 48h max)',
      ignoreFocusOut: true,
    });
    if (keepAlive === undefined) {
      return;
    }

    // Restore a preserved disk if requested, or if a snapshot was passed in.
    let snapshotId = initialSnapshotId;
    if (!snapshotId) {
      const useSnapshot = await vscode.window.showQuickPick(
        [
          { label: 'No', description: 'Start with a fresh disk' },
          { label: 'Yes', description: 'Restore a previously saved disk snapshot' },
        ],
        {
          placeHolder: 'Create from a saved disk snapshot?',
          ignoreFocusOut: true,
        }
      );
      if (useSnapshot === undefined) {
        return;
      }
      if (useSnapshot.label === 'Yes') {
        const snapshot = await pickSnapshot(api, 'Select a snapshot to restore');
        if (!snapshot) {
          return;
        }
        snapshotId = snapshot.id;
      }
    }

    const devbox = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Creating Runloop devbox...',
        cancellable: false,
      },
      () =>
        api.createDevbox({
          name: name.trim() || undefined,
          resourceSize,
          keepAliveSeconds: keepAlive.seconds,
          snapshotId,
        })
    );

    const label = devbox.name || devbox.id;
    const action = await vscode.window.showInformationMessage(
      `Devbox created: ${label} (${devbox.id}) — status: ${devbox.status}`,
      'Save SSH config'
    );
    if (action === 'Save SSH config') {
      await saveSshConfigForDevbox(api, devbox);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create devbox: ${errMessage(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Command: List devboxes, pick one, save SSH config                   */
/* ------------------------------------------------------------------ */

export async function selectDevboxAndSaveSSH(context: vscode.ExtensionContext): Promise<void> {
  try {
    const api = await requireApi(context);
    const devbox = await pickDevbox(api, undefined, 'Select a devbox to configure SSH for', ['shutdown']);
    if (!devbox) {
      return;
    }
    await saveSshConfigForDevbox(api, devbox);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to save SSH config: ${errMessage(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Command: Actively suspend / resume a devbox                         */
/* ------------------------------------------------------------------ */

export async function suspendDevbox(
  context: vscode.ExtensionContext,
  devbox?: Devbox
): Promise<void> {
  try {
    const api = await requireApi(context);
    const target = devbox ?? (await pickDevbox(api, ['running'], 'Select a running devbox to suspend'));
    if (!target) {
      return;
    }
    const updated = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Suspending ${target.name || target.id}...`,
        cancellable: false,
      },
      () => api.suspendDevbox(target.id)
    );
    vscode.window.showInformationMessage(
      `Suspended ${target.name || target.id} (status: ${updated.status}). ` +
        'You can resume it later — state is preserved.'
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to suspend devbox: ${errMessage(err)}`);
  }
}

export async function resumeDevbox(
  context: vscode.ExtensionContext,
  devbox?: Devbox
): Promise<void> {
  try {
    const api = await requireApi(context);
    const target = devbox ?? (await pickDevbox(api, ['suspended'], 'Select a suspended devbox to resume'));
    if (!target) {
      return;
    }
    const updated = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Resuming ${target.name || target.id}...`,
        cancellable: false,
      },
      () => api.resumeDevbox(target.id)
    );
    vscode.window.showInformationMessage(
      `Resuming ${target.name || target.id} (status: ${updated.status}).`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to resume devbox: ${errMessage(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Snapshots: preserve disk state to reuse on a new devbox             */
/* ------------------------------------------------------------------ */

export async function snapshotDevbox(
  context: vscode.ExtensionContext,
  devbox?: Devbox
): Promise<void> {
  try {
    const api = await requireApi(context);
    const target = devbox ?? (await pickDevbox(api, ['running'], 'Select a running devbox to snapshot'));
    if (!target) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: 'Snapshot name (optional)',
      placeHolder: 'my-snapshot',
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return;
    }
    const snapshot = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Snapshotting disk of ${target.name || target.id}...`,
        cancellable: false,
      },
      () => api.snapshotDisk(target.id, name.trim() || undefined)
    );
    const action = await vscode.window.showInformationMessage(
      `Disk snapshot created: ${snapshot.name || snapshot.id} (from ${target.id}). ` +
        'You can reuse it when creating a new devbox.',
      'Create devbox from this snapshot'
    );
    if (action === 'Create devbox from this snapshot') {
      await createDevbox(context, snapshot.id);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to snapshot devbox: ${errMessage(err)}`);
  }
}

export async function listSnapshots(context: vscode.ExtensionContext): Promise<void> {
  try {
    const api = await requireApi(context);
    const snapshot = await pickSnapshot(api, 'Select a snapshot to manage');
    if (!snapshot) {
      return;
    }
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Create Devbox from this snapshot', description: snapshot.id },
        { label: 'Delete snapshot', description: 'This cannot be undone' },
      ],
      {
        placeHolder: `Manage snapshot ${snapshot.name || snapshot.id}`,
        ignoreFocusOut: true,
      }
    );
    if (!action) {
      return;
    }
    if (action.label.startsWith('Create')) {
      await createDevbox(context, snapshot.id);
    } else {
      const confirm = await vscode.window.showWarningMessage(
        `Delete snapshot ${snapshot.name || snapshot.id} (${snapshot.id})? This cannot be undone.`,
        { modal: true },
        'Delete'
      );
      if (confirm === 'Delete') {
        await api.deleteSnapshot(snapshot.id);
        vscode.window.showInformationMessage(`Snapshot ${snapshot.id} deleted.`);
      }
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to list snapshots: ${errMessage(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Shared: list devboxes and let the user pick one                     */
/* ------------------------------------------------------------------ */

async function pickSnapshot(
  api: RunloopApi,
  placeHolder: string
): Promise<DiskSnapshot | undefined> {
  const list = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Fetching snapshots...',
      cancellable: false,
    },
    () => api.listSnapshots(100)
  );

  if (list.snapshots.length === 0) {
    vscode.window.showWarningMessage(
      'No disk snapshots found. Use "Runloop: Snapshot Devbox Disk" to save one first.'
    );
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    list.snapshots.map((s) => ({
      label: s.name || s.id,
      description: s.id,
      detail: `from devbox ${s.source_devbox_id || '?'} · ${
        s.size_bytes != null ? `${Math.round(s.size_bytes / (1024 * 1024))} MB` : 'size unknown'
      }`,
      snapshot: s,
    })),
    {
      placeHolder,
      matchOnDescription: true,
      ignoreFocusOut: true,
    }
  );
  return pick?.snapshot;
}

async function pickDevbox(
  api: RunloopApi,
  allowedStatuses: string[] | undefined,
  placeHolder: string,
  excludeStatuses: string[] = []
): Promise<Devbox | undefined> {
  const list = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Fetching devboxes...',
      cancellable: false,
    },
    () => api.listDevboxes(100)
  );

  let candidates = allowedStatuses
    ? list.devboxes.filter((db) => allowedStatuses.includes(db.status))
    : list.devboxes;
  if (excludeStatuses.length > 0) {
    candidates = candidates.filter((db) => !excludeStatuses.includes(db.status));
  }

  if (candidates.length === 0) {
    vscode.window.showWarningMessage(
      allowedStatuses
        ? `No devboxes found with status ${allowedStatuses.join(', ')}.`
        : 'No devboxes found. Create one first.'
    );
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    candidates.map((db) => ({
      label: db.name || db.id,
      description: db.id,
      detail: `status: ${db.status}`,
      devbox: db,
    })),
    {
      placeHolder,
      matchOnDescription: true,
      ignoreFocusOut: true,
    }
  );
  return pick?.devbox;
}

/* ------------------------------------------------------------------ */
/* Tree view: list devboxes (quiet — no prompts)                       */
/* ------------------------------------------------------------------ */

/** Lists devboxes for the Sandboxes tree. Returns [] when the API key is
 * missing or the request fails, without showing any prompt. Devboxes that
 * have been shut down are filtered out — they are in a terminal state and
 * can't be connected to. */
export async function listDevboxes(context: vscode.ExtensionContext): Promise<Devbox[]> {
  const key = await getApiKey(context, true);
  if (!key) {
    return [];
  }
  try {
    const api = new RunloopApi(key);
    const list = await api.listDevboxes(100);
    return (list.devboxes ?? []).filter((db) => db.status !== 'shutdown');
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Shared: create SSH key + write ~/.ssh/runloop.conf                   */
/* ------------------------------------------------------------------ */

/**
 * SSH files are saved to ~/.ssh of the machine running the extension host.
 * In a remote session (SSH / WSL / container) that would be the REMOTE
 * machine, not the user's local machine. Warn and let the user decide.
 */
async function ensureLocalSshTarget(): Promise<boolean> {
  const remote = vscode.env.remoteName;
  if (!remote) {
    return true; // running on the local desktop machine
  }
  const detail =
    remote === 'wsl'
      ? 'WSL session: files would go to the WSL machine (~/.ssh), not Windows (C:\\Users\\<you>\\.ssh).'
      : `Remote session (${remote}): files would go to the REMOTE machine's ~/.ssh, not your local machine.`;
  const choice = await vscode.window.showWarningMessage(
    `SSH files are saved to ~/.ssh of the machine running VS Code.\n${detail}`,
    { modal: true },
    'Cancel',
    'Save here anyway'
  );
  return choice === 'Save here anyway';
}

async function saveSshConfigForDevbox(api: RunloopApi, devbox: Devbox): Promise<void> {
  if (!(await ensureLocalSshTarget())) {
    return;
  }

  const sshKey = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating SSH key for ${devbox.id}...`,
      cancellable: false,
    },
    () => api.createSshKey(devbox.id)
  );

  const keyPath = await writePrivateKey(sshKey.ssh_private_key);
  const alias = hostAliasFor(sshKey.id);
  const block = buildSshBlock(sshKey, keyPath);
  const configPath = await writeSshConfig(block, alias);

  // Make sure ~/.ssh/config includes runloop.conf so `ssh runloop-<id>` works.
  await ensureIncludeLine();

  const choice = await vscode.window.showInformationMessage(
    `SSH config saved to ${configPath}. Connect with: ssh ${alias}`,
    'Open config',
    'Copy SSH command'
  );

  if (choice === 'Open config') {
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc, { preview: false });
  } else if (choice === 'Copy SSH command') {
    await vscode.env.clipboard.writeText(`ssh ${alias}`);
    vscode.window.showInformationMessage(`Copied "ssh ${alias}" to clipboard.`);
  }
}

/**
 * Configures SSH for a specific devbox and returns the SSH host alias so the
 * caller can open a Remote-SSH window. Returns undefined on failure.
 */
export async function connectToDevbox(
  devbox: Devbox,
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): Promise<string | undefined> {
  try {
    const api = await requireApi(context);
    const sshKey = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating SSH key for ${devbox.id}...`,
        cancellable: false,
      },
      () => api.createSshKey(devbox.id)
    );

    const keyPath = await writePrivateKey(sshKey.ssh_private_key);
    const alias = hostAliasFor(sshKey.id);
    const block = buildSshBlock(sshKey, keyPath);
    const configPath = await writeSshConfig(block, alias);
    await ensureIncludeLine();

    outputChannel.show(true);
    outputChannel.appendLine(`[Runloop] SSH config saved to ${configPath} (Host: ${alias})`);
    return alias;
  } catch (err) {
    const message = errMessage(err);
    outputChannel.appendLine(`[Runloop] Error: ${message}`);
    vscode.window.showErrorMessage(`Failed to configure SSH: ${message}`);
    return undefined;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof RunloopApiError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
