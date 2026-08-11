/**
 * Helpers to persist Runloop devbox SSH credentials on the local machine:
 *  - private key  -> ~/.ssh/runloop_key
 *  - SSH config   -> ~/.ssh/runloop.conf (overwritten each time)
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { SshKeyInfo } from "./runloopApi";

export function getSshDir(): string {
  return path.join(os.homedir(), ".ssh");
}

export function getSshConfigPath(): string {
  return path.join(getSshDir(), "runloop.conf");
}

/**
 * Single shared private key file. The key is ALWAYS written to this same path
 * and overwrites any previous devbox key, so only one devbox is "active" at a
 * time. (OpenSSH refuses keys with broad permissions, hence the 0600 mode.)
 */
export const SHARED_PRIVATE_KEY_FILE = "runloop_key";

export function getPrivateKeyPath(): string {
  return path.join(getSshDir(), SHARED_PRIVATE_KEY_FILE);
}

/** Strip scheme (ssh://, https://, ...) and trailing slash from a host URL. */
export function sanitizeHost(url: string): string {
  let host = url.trim();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  host = host.replace(/\/+$/, "");
  return host;
}

/** Host alias used both as the SSH Host name and the config block marker. */
export function hostAliasFor(devboxId: string): string {
  return `${devboxId}`;
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
    `    ProxyCommand pwsh -NoProfile -Command "openssl s_client -quiet -servername %h -connect ssh.runloop.ai:443 2>\`$null"`,
    `# END RUNLOOP DEVBOX ${alias}`,
    "",
  ];
  return lines.join("\n");
}

/** Write (or replace) the SSH config for a devbox in ~/.ssh/runloop.conf.
 * Always overwrites the entire file with the new block. */
export async function writeSshConfig(
  block: string,
  _alias: string,
): Promise<string> {
  const configPath = getSshConfigPath();
  await fs.mkdir(getSshDir(), { recursive: true });
  await fs.writeFile(configPath, block, "utf8");
  return configPath;
}

/**
 * Write the private key (always to the shared file, replacing any old key)
 * with restrictive permissions and return its path.
 */
export async function writePrivateKey(privateKey: string): Promise<string> {
  const keyPath = getPrivateKeyPath();
  await fs.mkdir(getSshDir(), { recursive: true });
  await fs.writeFile(keyPath, privateKey.trimEnd() + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return keyPath;
}

/** Reads the runloop SSH config file (returns "" when it does not exist). */
export async function readSshConfig(): Promise<string> {
  try {
    return await fs.readFile(getSshConfigPath(), "utf8");
  } catch {
    return "";
  }
}

/** True when the shared private key file exists on disk. */
export async function privateKeyFileExists(): Promise<boolean> {
  try {
    await fs.access(getPrivateKeyPath());
    return true;
  } catch {
    return false;
  }
}
