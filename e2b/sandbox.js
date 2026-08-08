import { Sandbox } from "e2b";
import { Template, waitForPort, defaultBuildLogger } from "e2b";

// E2B_API_KEY is read from the environment (the e2b SDK picks it up
// automatically). Set it in your shell or a gitignored .env file, e.g.
//   export E2B_API_KEY=e2b_...
if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is not set. Export it before running.");
  process.exit(1);
}

const paginator = Sandbox.list();

const firstPage = await paginator.nextItems();

let sandbox = firstPage[0];

if (!sandbox) {
  console.log("No running sandbox found, creating one...");
  sandbox = await Sandbox.create("ssh-ready", {
    timeoutMs: 300000,
    lifecycle: {
      onTimeout: { action: "pause", keepMemory: true },
      autoResume: true,
    },
  });
  console.log("Created sandbox with ID:", sandbox.sandboxId);
}

if (sandbox.state === "paused") {
  console.log(`Sandbox ${sandbox.sandboxId} is paused`);
  sandbox = await Sandbox.connect(sandbox.sandboxId);
  console.log(`Sandbox ${sandbox.sandboxId} resumed`);
}

// Start the keepalive daemon: while an SSH session is open it bumps the sandbox
// TTL via the REST API so the websocat-forwarded connection isn't paused out
// from under us. It self-guards against duplicates (flock), so re-running this
// on reconnect is safe. E2B_API_KEY is injected here because the build-time
// start command can't see create-time env vars.
//
// `setsid` + stdio redirection is REQUIRED: a plain `background: true` command
// is tied to the SDK connection and gets killed when this node process exits,
// so the daemon would die immediately. setsid detaches it into its own session
// so it keeps running for the sandbox's lifetime.
await sandbox.commands.run(
  "setsid /usr/local/bin/e2b-keepalive </dev/null >/tmp/e2b-keepalive.log 2>&1",
  {
    background: true,
    envs: {
      E2B_API_KEY: process.env.E2B_API_KEY,
      E2B_SANDBOX_ID: sandbox.sandboxId,
      E2B_TTL_SECONDS: "300",
      E2B_KEEPALIVE_INTERVAL: "60",
    },
  },
);
console.log("Keepalive daemon started (bumps TTL while SSH is connected).");

console.log(
  `ssh -o 'ProxyCommand=websocat --binary -B 65536 - wss://8081-${sandbox.sandboxId}.e2b.app' user@${sandbox.sandboxId}`,
);
