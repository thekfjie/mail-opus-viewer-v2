import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distWeb = path.join(root, "dist", "web");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const git = (args) => {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
};
const files = [];
for (const directory of [path.join(distWeb, "assets"), path.join(root, "dist", "server")]) {
  if (!fs.existsSync(directory)) continue;
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(directory);
}
files.sort();
const hash = crypto.createHash("sha256");
for (const file of files) hash.update(path.relative(root, file)).update("\0").update(fs.readFileSync(file));
const manifest = {
  project: readJson(path.join(root, "package.json")).name,
  version: readJson(path.join(root, "package.json")).version,
  gitCommit: git(["rev-parse", "HEAD"]),
  gitDirty: git(["status", "--porcelain"]) !== "",
  builtAt: new Date().toISOString(),
  artifactSha256: hash.digest("hex"),
  frontendEntry: fs.existsSync(path.join(distWeb, "index.html")) ? fs.readFileSync(path.join(distWeb, "index.html"), "utf8").match(/src="(\/assets\/[^\"]+\.js)"/)?.[1] || "" : "",
};
fs.writeFileSync(path.join(root, "dist", "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(`release manifest: ${manifest.gitCommit} ${manifest.artifactSha256.slice(0, 12)}`);
