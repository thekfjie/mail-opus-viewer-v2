import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
if (args[0] === "--isolated") {
  // Mounts exist only in this user/mount namespace; host paths are untouched.
  for (const directory of ["/opt/mail-opus-viewer", "/opt/mail-opus-viewer-v2", "/var/lib/mail-opus-v2", "/var/backups/mail-opus-v2", "/opt/automyai", "/opt/outlookEmail"]) {
    if (!fs.existsSync(directory)) continue;
    const mount = spawnSync("mount", ["-t", "tmpfs", "-o", "size=1m,ro", "offline-hidden", directory], { stdio: "inherit" });
    if (mount.status !== 0) process.exit(mount.status || 1);
  }
  const loopback = spawnSync("ip", ["link", "set", "lo", "up"], { stdio: "inherit" });
  if (loopback.status !== 0) process.exit(loopback.status || 1);
  const command = args.slice(1);
  const result = spawnSync(command[0] || "npm", command.length ? command.slice(1) : ["test"], { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "opus-v2-offline-"));
const command = args[0] === "--" ? args.slice(1) : args;
try {
  const result = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--net", process.execPath, self, "--isolated", ...command], {
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      HOME: temporary,
      TMPDIR: temporary,
      ENV_FILE: "/dev/null",
      PROJECT_ROOT: path.resolve(path.dirname(self), ".."),
      DATABASE_PATH: path.join(temporary, "default.sqlite"),
      V1_ENV_FILE: "/dev/null",
      OUTLOOK_MANAGER_ENV_FILE: "/dev/null",
      AUTOMYAI_CONFIG_PATH: "/dev/null",
      V2_SESSION_SECRET: "offline-session-key-not-for-deployment",
      CREDENTIAL_ENCRYPTION_KEY: "offline-encryption-key-not-for-deployment",
      VIEWER_ADMIN_PASSWORD: "offline-admin-not-for-deployment",
      V2_ACCOUNT_AUTHORITY: "v2",
      V2_AUTO_TRIAL_ENABLED: "false",
      PAYMENT_EXPOSURE_PROMOTION_PROXY_JP: "http://127.0.0.1:9",
    },
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
