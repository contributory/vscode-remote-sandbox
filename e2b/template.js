// template.ts
import { Template, waitForPort, defaultBuildLogger } from "e2b";

// E2B_API_KEY is read from the environment (the e2b SDK picks it up
// automatically). Set it in your shell or a gitignored .env file, e.g.
//   export E2B_API_KEY=e2b_...
if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is not set. Export it before running.");
  process.exit(1);
}

// Git identity baked into user space (~/.gitconfig) so commits made from an
// SSH session are attributed correctly. Override with GIT_USER_NAME /
// GIT_USER_EMAIL env vars.
const gitUserName = process.env.GIT_USER_NAME || "contributory";
const gitUserEmail = process.env.GIT_USER_EMAIL || "bosuutap@alwaysdata.net";

const template = Template()
  .fromUbuntuImage("25.04")
  .aptInstall([
    "openssh-server",
    "docker.io",
    "curl",
    "wget",
    "git",
    "python3",
    "python3-pip",
    "python3-venv",
    "python-is-python3",
  ])
  .runCmd(
    [
      "curl -fsSL https://deb.nodesource.com/setup_current.x | bash -",
      "apt-get install -y nodejs",
    ],
    { user: "root" },
  )
  .runCmd(
    [
      "curl -fsSL -o /usr/local/bin/websocat https://github.com/vi/websocat/releases/latest/download/websocat.x86_64-unknown-linux-musl",
      "chmod a+x /usr/local/bin/websocat",
    ],
    { user: "root" },
  )
  // Bake the git identity into the SSH user's space (~/.gitconfig). Run as
  // the default "user" (not root) so it lands in /home/user/.gitconfig, which
  // is what `ssh user@<sandbox>` sessions read.
  .runCmd(
    [
      `git config --global user.name "${gitUserName}"`,
      `git config --global user.email "${gitUserEmail}"`,
    ],
    { user: "user" },
  )
  // Bake the keepalive daemon into the image. It's launched later from the SDK
  // (sandbox.js), not from the start command, because env vars passed at
  // Sandbox.create() time (E2B_API_KEY) are invisible to the build-time start
  // command but visible to SDK-launched commands.
  .copy("keepalive.sh", "/usr/local/bin/e2b-keepalive", { mode: 0o755 })
  .setStartCmd(
    "sudo websocat -b --exit-on-eof ws-l:0.0.0.0:8081 tcp:127.0.0.1:22",
    waitForPort(8081),
  );

await Template.build(template, "ssh-ready", {
  cpuCount: 4,
  memoryMB: 8192,
  onBuildLogs: defaultBuildLogger(),
});
