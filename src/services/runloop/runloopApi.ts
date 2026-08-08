/**
 * Minimal REST client for the Runloop Devbox API.
 * Docs: https://docs.runloop.ai/api-reference/devbox
 * Base URL: https://api.runloop.ai  (Bearer token auth via RUNLOOP_API_KEY)
 */

export const RUNLOOP_API_BASE = 'https://api.runloop.ai';

export interface Devbox {
  id: string;
  name: string | null;
  status: string;
  create_time_ms?: number;
  end_time_ms?: number | null;
  launch_parameters?: unknown;
  metadata?: Record<string, string>;
}

export interface DevboxListView {
  devboxes: Devbox[];
  has_more: boolean;
  total_count: number | null;
}

export interface SshKeyInfo {
  id: string;
  url: string;
  ssh_private_key: string;
  ssh_user: string;
}

export interface DiskSnapshot {
  id: string;
  name: string | null;
  create_time_ms?: number;
  metadata?: Record<string, string>;
  source_devbox_id?: string;
  source_blueprint_id?: string | null;
  commit_message?: string | null;
  size_bytes?: number | null;
}

export interface DiskSnapshotListView {
  snapshots: DiskSnapshot[];
  has_more: boolean;
  total_count: number | null;
}

export interface CreateDevboxOptions {
  name?: string;
  resourceSize?: string;
  keepAliveSeconds?: number;
  /** Restore disk state from a previously saved snapshot. */
  snapshotId?: string;
}

export class RunloopApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = 'RunloopApiError';
  }
}

export class RunloopApi {
  constructor(private readonly apiKey: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${RUNLOOP_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new RunloopApiError(`Network error contacting Runloop API: ${(err as Error).message}`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new RunloopApiError(
        `Runloop API ${method} ${path} failed (${res.status}): ${text || res.statusText}`,
        res.status,
        text
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** GET /v1/devboxes — list devboxes (optionally filtered by status). */
  async listDevboxes(limit = 100): Promise<DevboxListView> {
    return this.request<DevboxListView>(
      'GET',
      `/v1/devboxes?limit=${limit}&include_total_count=false`
    );
  }

  /**
   * POST /v1/devboxes — create a new devbox and start booting it.
   *
   * keepAliveSeconds maps to launch_parameters.keep_alive_time_seconds.
   * Runloop's max lifetime is 172800s (48h); there is no literal "never",
   * so the maximum value is used to prevent auto-shutdown for as long as
   * the API allows. Leave undefined to use the platform default (1h).
   * snapshotId restores disk state from a saved snapshot.
   */
  async createDevbox(opts: CreateDevboxOptions): Promise<Devbox> {
    const launchParameters: Record<string, unknown> = {};
    if (opts.resourceSize) {
      launchParameters.resource_size_request = opts.resourceSize;
    }
    if (opts.keepAliveSeconds !== undefined) {
      launchParameters.keep_alive_time_seconds = opts.keepAliveSeconds;
    }

    const body: Record<string, unknown> = {};
    if (opts.name) {
      body.name = opts.name;
    }
    if (opts.snapshotId) {
      body.snapshot_id = opts.snapshotId;
    }
    if (Object.keys(launchParameters).length > 0) {
      body.launch_parameters = launchParameters;
    }
    return this.request<Devbox>('POST', '/v1/devboxes', body);
  }

  /** POST /v1/devboxes/{id}/create_ssh_key — create SSH key for a devbox. */
  async createSshKey(devboxId: string): Promise<SshKeyInfo> {
    return this.request<SshKeyInfo>(
      'POST',
      `/v1/devboxes/${encodeURIComponent(devboxId)}/create_ssh_key`,
      {}
    );
  }

  /** POST /v1/devboxes/{id}/suspend — suspend a running devbox (resumable). */
  async suspendDevbox(devboxId: string): Promise<Devbox> {
    return this.request<Devbox>(
      'POST',
      `/v1/devboxes/${encodeURIComponent(devboxId)}/suspend`,
      {}
    );
  }

  /** POST /v1/devboxes/{id}/resume — resume a suspended devbox. */
  async resumeDevbox(devboxId: string): Promise<Devbox> {
    return this.request<Devbox>(
      'POST',
      `/v1/devboxes/${encodeURIComponent(devboxId)}/resume`,
      {}
    );
  }

  /** POST /v1/devboxes/{id}/snapshot_disk — synchronously snapshot a running devbox's disk. */
  async snapshotDisk(devboxId: string, name?: string, commitMessage?: string): Promise<DiskSnapshot> {
    const body: Record<string, unknown> = {};
    if (name) {
      body.name = name;
    }
    if (commitMessage) {
      body.commit_message = commitMessage;
    }
    return this.request<DiskSnapshot>(
      'POST',
      `/v1/devboxes/${encodeURIComponent(devboxId)}/snapshot_disk`,
      body
    );
  }

  /** GET /v1/devboxes/disk_snapshots — list saved disk snapshots. */
  async listSnapshots(limit = 100): Promise<DiskSnapshotListView> {
    return this.request<DiskSnapshotListView>(
      'GET',
      `/v1/devboxes/disk_snapshots?limit=${limit}&include_total_count=false`
    );
  }

  /** POST /v1/devboxes/disk_snapshots/{id}/delete — delete a disk snapshot. */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/v1/devboxes/disk_snapshots/${encodeURIComponent(snapshotId)}/delete`,
      {}
    );
  }
}
