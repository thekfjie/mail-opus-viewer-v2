import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type SmokeReport = { ok: boolean; checks: Record<string, boolean>; counts: Record<string, number> };

export async function smokeProduction(args = process.argv.slice(2), transport: typeof fetch = globalThis.fetch): Promise<SmokeReport> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!["--base", "--database", "--env"].includes(args[index]) || !args[index + 1] || options.has(args[index])) throw new Error("invalid_arguments");
    options.set(args[index], args[index + 1]);
  }
  if (options.size !== 3) throw new Error("explicit_candidate_database_and_environment_required");
  const base = new URL(options.get("--base")!);
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(base.hostname)
    || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("candidate_must_be_explicit_loopback_origin");
  const environmentFile = fs.realpathSync(options.get("--env")!);
  if ((fs.statSync(environmentFile).mode & 0o077) !== 0) throw new Error("environment_must_be_private");
  const environment = parseEnv(fs.readFileSync(environmentFile, "utf8"));
  const adminPassword = environment.VIEWER_ADMIN_PASSWORD || environment.MAIL_ADMIN_AUTH || "";
  const encryptionSource = environment.CREDENTIAL_ENCRYPTION_KEY
    || (environment.V2_SESSION_SECRET || environment.SESSION_SECRET ? `${environment.V2_SESSION_SECRET || environment.SESSION_SECRET}:mail-opus-v2-credentials` : "");
  if (!adminPassword || !encryptionSource) throw new Error("protected_environment_credentials_missing");
  const encryptionKey = crypto.createHash("sha256").update(encryptionSource).digest();
  const decrypt = (value: string) => {
    if (!value) return "";
    const [version, nonce, tag, content] = value.split(".");
    if (version !== "v1" || !nonce || !tag || !content) throw new Error("invalid_encrypted_credential");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(content, "base64url")), decipher.final()]).toString("utf8");
  };
  const database = new Database(fs.realpathSync(options.get("--database")!), { readonly: true, fileMustExist: true });
  let customer: { email: string; password: string; publicToken: string } | undefined;
  try {
    database.pragma("query_only = ON");
    const grants = database.prepare(`SELECT g.login_identifier_enc,g.password_plain_enc,g.public_token_enc,g.login_identifier_hash
      FROM access_grants g JOIN gpt_accounts a ON a.id=g.account_id
      WHERE g.active=1 AND g.scope!='admin_only' AND g.password_plain_enc!='' AND g.public_token_enc!='' AND a.deleted_at=''
      ORDER BY (g.scope='current') DESC,g.created_at DESC LIMIT 50`).all() as any[];
    for (const grant of grants) {
      const password = decrypt(String(grant.password_plain_enc));
      const duplicate = database.prepare(`SELECT COUNT(*) n FROM access_grants
        WHERE active=1 AND scope!='admin_only' AND login_identifier_hash=?`).get(grant.login_identifier_hash) as any;
      if (password && Number(duplicate.n) === 1) {
        customer = { email: decrypt(String(grant.login_identifier_enc)), password, publicToken: decrypt(String(grant.public_token_enc)) };
        break;
      }
    }
  } finally { database.close(); }
  const checks: Record<string, boolean> = { customerGrantAvailable: Boolean(customer) };
  const counts: Record<string, number> = { requests: 0, adminAccountsReturned: 0, mappingsReturned: 0, pendingMailboxesReturned: 0, customerMailHeadersReturned: 0, staticAssetsChecked: 0, mailBodyRequests: 0 };
  const request = async (key: string, pathname: string, input: { method?: "POST"; cookie?: string; body?: unknown } = {}) => {
    const url = new URL(pathname, base);
    if (url.origin !== base.origin || counts.requests >= 32 || /mail-detail|verification-code|backfill|mail-events/.test(url.pathname)) throw new Error("request_outside_smoke_scope");
    counts.requests += 1;
    const response = await transport(url, {
      method: input.method || "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json, text/html;q=0.9, */*;q=0.1", ...(input.cookie ? { cookie: input.cookie } : {}),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }) },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    checks[key] = response.status === 200;
    if (!url.pathname.startsWith("/assets/")) checks[`${key}NoStore`] = response.headers.get("cache-control")?.includes("no-store") === true;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("response_exceeds_smoke_limit"); }
        chunks.push(next.value);
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { text, json, response };
  };
  const cookie = (response: Response, name: string) => response.headers.getSetCookie()
    .map((value) => value.split(";")[0]).find((value) => value.startsWith(name + "=")) || "";
  const health = await request("health", "/health");
  checks.independentRuntime = health.json?.independent === true && health.json?.commandWriter === "v2";
  const legacyLogin = await request("legacyAdminLogin", "/api/admin/login", { method: "POST", body: { password: adminPassword } });
  const alias = cookie(legacyLogin.response, "mail_opus_admin");
  checks.legacyAdminCookie = Boolean(alias);
  checks.loopbackCookieAccepted = legacyLogin.response.headers.getSetCookie().some((value) => value.startsWith("mail_opus_admin=") && !/;\s*secure\b/i.test(value));
  const aliasSession = await request("legacyAdminSession", "/api/admin/session", { cookie: alias });
  checks.legacyAdminSessionShape = aliasSession.json?.ok === true;
  const mappings = await request("compatibilityMappings", "/api/admin/mappings?includeRebindTargets=1", { cookie: alias });
  checks.compatibilityMappingsShape = Array.isArray(mappings.json?.results);
  counts.mappingsReturned = mappings.json?.results?.length || 0;
  const pending = await request("compatibilityPending", "/api/admin/pending-mailboxes", { cookie: alias });
  checks.compatibilityPendingShape = Array.isArray(pending.json?.results);
  counts.pendingMailboxesReturned = pending.json?.results?.length || 0;
  const adminLogin = await request("v2AdminLogin", "/api/v2/admin/login", { method: "POST", body: { password: adminPassword } });
  const adminCookie = cookie(adminLogin.response, "mail_opus_v2_admin");
  checks.v2AdminCookie = Boolean(adminCookie);
  const accounts = await request("adminAccounts", "/api/v2/admin/accounts?limit=5", { cookie: adminCookie });
  checks.adminAccountsShape = Array.isArray(accounts.json?.results) && Number.isFinite(accounts.json?.total);
  counts.adminAccountsReturned = accounts.json?.results?.length || 0;
  const overview = await request("adminOverview", "/api/v2/admin/overview", { cookie: adminCookie });
  checks.adminOverviewShape = overview.json?.independent === true && overview.json?.commandWriter === "v2";
  const root = await request("customerHtml", "/");
  checks.customerHtmlShape = root.text.includes("/customer.js");
  const customerScript = await request("customerScript", "/customer.js");
  checks.customerScriptNoPersistence = !/localStorage|sessionStorage|indexedDB|serviceWorker/.test(customerScript.text);
  const adminHtml = await request("adminHtml", "/admin");
  const assets = [...new Set([...adminHtml.text.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]))];
  checks.adminHtmlShape = adminHtml.text.includes('id="root"') && assets.length > 0;
  for (const [index, asset] of assets.slice(0, 8).entries()) {
    const result = await request(`staticAsset${index}`, asset);
    checks[`staticAsset${index}Nonblank`] = result.text.length > 0;
    counts.staticAssetsChecked += 1;
  }
  if (customer) {
    const preset = await request("customerPreset", "/api/preset?m=" + encodeURIComponent(customer.publicToken));
    checks.customerPresetShape = preset.json?.email === customer.email && preset.json?.password === customer.password;
    const login = await request("customerLogin", "/api/login", { method: "POST", body: { email: customer.email, password: customer.password } });
    const customerCookie = cookie(login.response, "mail_opus_v2_customer");
    checks.customerCookie = Boolean(customerCookie);
    const session = await request("customerSession", "/api/session", { cookie: customerCookie });
    checks.customerSessionShape = session.json?.ok === true && session.json?.email === customer.email;
    const mails = await request("customerMails", "/api/mails?limit=5", { cookie: customerCookie });
    checks.customerMailsShape = Array.isArray(mails.json?.results) && Number.isFinite(mails.json?.count);
    counts.customerMailHeadersReturned = mails.json?.results?.length || 0;
    const forbidden = new Set(["raw", "body", "html", "text", "accessToken", "refreshToken", "sessionToken", "recipient_enc", "metadata_json"]);
    checks.customerIndexOnly = Array.isArray(mails.json?.results)
      && mails.json.results.every((mail: any) => Object.keys(mail).every((key) => !forbidden.has(key)));
    await request("customerLogout", "/api/logout", { method: "POST", cookie: customerCookie });
  }
  await request("legacyAdminLogout", "/api/admin/logout", { method: "POST", cookie: alias });
  await request("v2AdminLogout", "/api/v2/admin/logout", { method: "POST", cookie: adminCookie });
  return { ok: Object.values(checks).every(Boolean), checks, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await smokeProduction();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 2;
  } catch {
    process.stderr.write("Candidate smoke check failed; credentials and responses were not recorded.\n");
    process.exitCode = 1;
  }
}
