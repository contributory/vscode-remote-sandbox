/**
 * Helpers to persist Runloop devbox SSH credentials on the local machine:
 *  - private key  -> ~/.ssh/runloop-<devboxId>
 *  - SSH config   -> ~/.ssh/runloop.conf  (a block per devbox, idempotent)
 *  - include line -> ~/.ssh/config  (Include ~/.ssh/runloop.conf)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SshKeyInfo } from './runloopApi';

export function getSshDir(): string {
  return path.join(os.homedir(), '.ssh');
}

export function getSshConfigPath(): string {
  return path.join(getSshDir(), 'runloop.conf');
}

/**
 * Single shared private key file. The key is ALWAYS written to this same path
 * and overwrites any previous devbox key, so only one devbox is "active" at a
 * time. (OpenSSH refuses keys with broad permissions, hence the 0600 mode.)
 */
export const SHARED_PRIVATE_KEY_FILE = 'runloop_key';

export function getPrivateKeyPath(): string {
  return path.join(getSshDir(), SHARED_PRIVATE_KEY_FILE);
}

/** Strip scheme (ssh://, https://, ...) and trailing slash from a host URL. */
export function sanitizeHost(url: string): string {
  let host = url.trim();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  host = host.replace(/\/+$/, '');
  return host;
}

/** Host alias used both as the SSH Host name and the config block marker. */
export function hostAliasFor(devboxId: string): string {
  return `runloop-${devboxId}`;
}

/** Build an SSH config block for one devbox. */
export function buildSshBlock(info: SshKeyInfo, keyPath: string): string {
  const alias = hostAliasFor(info.id);
  const lines = [
    `# BEGIN RUNLOOP DEVBOX ${alias}`,
    `Host ${alias}`,
    `    HostName ${sanitizeHost(info.url)}`,
    `    User ${info.ssh_user}`,
    `    IdentityFile ${keyPath}`,
    `    StrictHostKeyChecking no`,
    `    UserKnownHostsFile /dev/null`,
    `    ServerAliveInterval 60`,
    `    ServerAliveCountMax 3`,
    `# END RUNLOOP DEVBOX ${alias}`,
    '',
  ];
  return lines.join('\n');
}

/** Write (or replace) the SSH config block for a devbox in ~/.ssh/runloop.conf. */
export async function writeSshConfig(block: string, alias: string): Promise<string> {
  const configPath = getSshConfigPath();
  await fs.mkdir(getSshDir(), { recursive: true });

  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch {
    // file does not exist yet
  }

  const begin = `# BEGIN RUNLOOP DEVBOX ${alias}`;
  const end = `# END RUNLOOP DEVBOX ${alias}`;
  const startIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);

  let next: string;
  if (startIdx >= 0 && endIdx >= 0) {
    next = existing.slice(0, startIdx) + block + existing.slice(endIdx + end.length);
  } else {
    next = existing.trimEnd() + (existing.trim() ? '\n\n' : '') + block;
  }

  await fs.writeFile(configPath, next, 'utf8');
  return configPath;
}

/**
 * Write the private key (always to the shared file, replacing any old key)
 * with restrictive permissions and return its path.
 */
export async function writePrivateKey(privateKey: string): Promise<string> {
  const keyPath = getPrivateKeyPath();
  await fs.mkdir(getSshDir(), { recursive: true });
  await fs.writeFile(keyPath, privateKey.trimEnd() + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  return keyPath;
}

/**
 * Make sure ~/.ssh/config has `Include ~/.ssh/runloop.conf`.
 * Returns true if the line was added, false if it already existed.
 */
export async function ensureIncludeLine(): Promise<boolean> {
  const configPath = path.join(getSshDir(), 'config');
  const includeLine = `Include ${getSshConfigPath()}`;
  try {
    let existing = '';
    try {
      existing = await fs.readFile(configPath, 'utf8');
    } catch {
      // no ~/.ssh/config yet
    }
    if (existing.includes('runloop.conf')) {
      return false;
    }
    await fs.writeFile(configPath, (existing.trimEnd() ? existing.trimEnd() + '\n\n' : '') + includeLine + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
