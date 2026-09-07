import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const manifestPath = path.join(dist, "release-manifest.json");
if (!fs.existsSync(manifestPath)) throw new Error("V2 release manifest is missing; run npm run build");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const currentCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (currentCommit !== String(manifest.gitCommit || "")) throw new Error("V2 Git commit does not match the published release manifest");
const indexPath = path.join(dist, "web", "index.html");
if (!fs.existsSync(indexPath)) throw new Error("V2 web index is missing; run npm run build");
const index = fs.readFileSync(indexPath, "utf8");
const entry = String(manifest.frontendEntry || "");
if (!entry || !index.includes(`src="${entry}"`)) throw new Error("V2 release manifest does not match the frontend entry");
const files = [];
for (const directory of [path.join(dist, "web", "assets"), path.join(dist, "server")]) {
  if (!fs.existsSync(directory)) throw new Error(`V2 build directory is missing: ${directory}`);
  const visit = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) visit(full);
      else if (item.isFile()) files.push(full);
    }
  };
  visit(directory);
}
files.sort();
const hash = crypto.createHash("sha256");
for (const file of files) hash.update(path.relative(root, file)).update("\0").update(fs.readFileSync(file));
if (String(manifest.artifactSha256 || "") !== hash.digest("hex")) throw new Error("V2 release artifact hash mismatch; refusing to start");
console.log(`V2 release verified: ${String(manifest.gitCommit || "unknown").slice(0, 12)} ${String(manifest.artifactSha256).slice(0, 12)}`);
