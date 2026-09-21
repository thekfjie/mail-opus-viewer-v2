import { spawn } from "node:child_process";
import { config } from "./config.js";

export interface OAuthMaterial {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

export interface OAuthProbeResult {
  status: "alive" | "dead" | "error";
  accessStatus: "alive" | "invalid" | "unknown" | "missing";
  refreshStatus: "alive" | "invalid" | "unknown" | "missing" | "unused";
  detail: string;
  rotatedTokens?: OAuthMaterial;
}

export type OAuthProbe = (material: OAuthMaterial) => Promise<OAuthProbeResult>;

export const probeOAuth: OAuthProbe = (material) => new Promise((resolve, reject) => {
  const child = spawn(config.oauthProbePython, [config.oauthProbeFile], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });
  let output = "";
  let rejected = false;
  const fail = (code: string) => { rejected = true; child.kill("SIGKILL"); reject(new Error(code)); };
  const timer = setTimeout(() => fail("oauth_probe_timeout"), 110_000);
  child.stdout.on("data", (value: Buffer) => {
    output += value.toString("utf8");
    if (Buffer.byteLength(output) > 128 * 1024) fail("oauth_probe_output_limit");
  });
  child.stderr.resume();
  child.stdin.on("error", () => fail("oauth_probe_stdin_error"));
  child.on("error", () => { clearTimeout(timer); fail("oauth_probe_unavailable"); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (rejected) return;
    if (code !== 0) return reject(new Error("oauth_probe_failed"));
    try {
      const parsed = JSON.parse(output);
      if (!["alive", "dead", "error"].includes(parsed.status)
        || !["alive", "invalid", "unknown", "missing"].includes(parsed.accessStatus)
        || !["alive", "invalid", "unknown", "missing", "unused"].includes(parsed.refreshStatus)
        || !/^[a-z0-9_]{1,80}$/.test(parsed.detail)) throw new Error();
      resolve({ status: parsed.status, accessStatus: parsed.accessStatus, refreshStatus: parsed.refreshStatus, detail: parsed.detail,
        ...(parsed.status === "alive" && parsed.rotatedTokens && typeof parsed.rotatedTokens.accessToken === "string"
          ? { rotatedTokens: { accessToken: parsed.rotatedTokens.accessToken, refreshToken: String(parsed.rotatedTokens.refreshToken || ""), idToken: String(parsed.rotatedTokens.idToken || "") } } : {}) });
    } catch { reject(new Error("oauth_probe_invalid_result")); }
  });
  child.stdin.end(JSON.stringify({ ...material, proxy: config.oauthHealthProxy, meUrl: config.oauthMeUrl, tokenUrl: config.oauthTokenUrl, timeout: 35 }));
});
