import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Never run nginx -t as host root: even test mode can chown shared temp paths.
// User, mount and network namespaces prevent this check from changing live nginx.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[2] !== "--inside") {
  if (process.getuid?.() === 0) throw new Error("Run this check as the unprivileged project owner, without sudo");
  const result = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--net", process.execPath,
    fileURLToPath(import.meta.url), "--inside"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  const mapping = fs.readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/).map(Number);
  if (mapping.length !== 3 || mapping[0] !== 0 || mapping[1] === 0 || mapping[2] !== 1) throw new Error("An unprivileged user namespace is required");
  const run = (file, args) => {
    const result = spawnSync(file, args, { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) throw new Error(`Isolated configuration check failed at ${path.basename(file)}`);
    return result;
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-nginx-review-"));
  try {
    run("mount", ["--make-rprivate", "/"]);
    // Host-owned paths are additionally hidden; no nginx build default can reach them.
    for (const location of ["/var/lib/nginx", "/var/log/nginx", "/run"]) {
      run("mount", ["-t", "tmpfs", "-o", "mode=0700,nosuid,nodev", "tmpfs", location]);
    }
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=offline.test",
      "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")]);
    const files = ["mail.opus.sryze.cc.nginx.conf", "cloud.opus.sryze.cc.cutover.nginx.conf", "opus-mail-v2-loopback.nginx.conf", "mailhook.kfjie.me.nginx.conf"];
    const includes = files.map((filename) => {
      const config = fs.readFileSync(path.join(root, "deploy", filename), "utf8")
        .replace(/ssl_certificate_key\s+[^;]+;/g, `ssl_certificate_key ${directory}/key.pem;`)
        .replace(/ssl_certificate\s+[^;]+;/g, `ssl_certificate ${directory}/cert.pem;`);
      const target = path.join(directory, filename);
      fs.writeFileSync(target, config);
      return `include ${target};`;
    });
    const config = `user root;\nerror_log stderr;\npid ${directory}/nginx.pid;\nevents { worker_connections 16; }\nhttp {\naccess_log off;\n`
      + ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"].map((kind) => `${kind}_temp_path ${directory}/${kind};`).join("\n")
      + "\n" + includes.join("\n") + "\n}\n";
    const filename = path.join(directory, "nginx.conf");
    fs.writeFileSync(filename, config);
    run("/usr/sbin/nginx", ["-t", "-c", filename]);
    process.stdout.write(JSON.stringify({ ok: true, configurations: files.length, unprivilegedUserNamespace: true,
      isolatedMounts: true, isolatedNetwork: true, productionCertificatesRead: false }) + "\n");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
