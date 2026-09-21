import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

type Db = Database.Database;
type Row = Record<string, any>;
type Table = "gpt_accounts" | "email_bindings" | "access_grants" | "sales";
interface Guard { table: Table; id: string; fingerprint: string }
interface Change { table: "access_grants" | "sales"; id: string; accountId: string; reason: string; before: Row; after: Row }
export interface LegacyLinkProof {
  grantId: string; bindingId: string; accountId: string; legacyMappingId: string;
  customerMaterialFingerprint: string; legacyFrom: string; legacyTo: string; legacyRetired: boolean;
  manualReceiveDisabled: boolean; manualReclaimed: boolean; placeholder: boolean;
  restoredAt: string;
}
export interface BanAccessRepair {
  guards: Guard[]; eventGuards: Array<{ accountId: string; fingerprint: string }>; relationGuards: Array<{ accountId: string; fingerprint: string }>;
  changes: Change[]; skipped: Array<{ grantId: string; reason: string }>;
  counts: { bannedGrants: number; restoredLegacyLinks: number; restoredBanWindows: number; reopenedSales: number; correctedHistoricalSales: number; skipped: number };
}

export function repairFingerprint(value: unknown): string {
  const normalize = (input: any): any => Array.isArray(input) ? input.map(normalize)
    : input && typeof input === "object" ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])])) : input;
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
function customerMaterial(grant: Row): string {
  return repairFingerprint([grant.public_token_hash, grant.public_token_enc, grant.login_identifier_hash,
    grant.login_identifier_enc, grant.password_hash, grant.password_plain_enc, grant.legacy_public_token]);
}
function validTime(value: unknown): string {
  if (!value) return "";
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) throw new Error("ban_repair_invalid_time");
  return new Date(at).toISOString();
}
function extreme(values: unknown[], which: "min" | "max"): string {
  const times = values.map(validTime).filter(Boolean).map(Date.parse);
  return times.length ? new Date(Math[which](...times)).toISOString() : "";
}
function row(database: Db, table: Table, id: string): Row | undefined {
  if (!["gpt_accounts", "email_bindings", "access_grants", "sales"].includes(table)) throw new Error("ban_repair_invalid_table");
  return database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Row | undefined;
}

// The verifier must validate original mapping ID, full password and email
// against the preserved V1 customer link. It never returns those values.
export function createLegacyLinkProofs(database: Db, originals: Row[], verify: (grant: Row, binding: Row, legacy: Row) => boolean, includeUnbanned = false): LegacyLinkProof[] {
  const byId = new Map(originals.map((record) => [String(record.id || ""), record]));
  const proofs: LegacyLinkProof[] = [];
  for (const grant of database.prepare("SELECT g.* FROM access_grants g JOIN gpt_accounts a ON a.id=g.account_id WHERE (?=1 OR a.deactivation_locked=1)").all(Number(includeUnbanned)) as Row[]) {
    const binding = row(database, "email_bindings", grant.binding_id);
    const original = binding ? byId.get(binding.legacy_mapping_id) : undefined;
    if (!binding || !original || !verify(grant, binding, original)) continue;
    const restoredAt = validTime(original.mailRestoredAt);
    const priorReclaim = extreme([original.restoredFromRetiredAt, original.restoredFromMailNotAfter], "max");
    const provenRestoration = original.lifecycleStatus === "active" && !original.retiredAt && !original.mailNotAfter
      && restoredAt && priorReclaim && Date.parse(restoredAt) > Date.parse(priorReclaim)
      && original.restoredFromLifecycleStatus === "retired" && Number(binding.is_current) === 1
      && Date.parse(binding.valid_from) >= Date.parse(restoredAt) && !byId.has(String(original.recycledToId || ""));
    proofs.push({ grantId: grant.id, bindingId: binding.id, accountId: grant.account_id,
      legacyMappingId: binding.legacy_mapping_id, customerMaterialFingerprint: customerMaterial(grant),
      legacyFrom: validTime(original.mailNotBefore), legacyTo: extreme([original.mailNotAfter, original.retiredAt], "min"),
      legacyRetired: original.lifecycleStatus === "retired", manualReceiveDisabled: Boolean(original.receiveDisabledAt),
      manualReclaimed: Boolean(original.lifecycleStatus === "retired" || original.retiredAt || (original.recycledToId && !provenRestoration)),
      restoredAt: provenRestoration ? restoredAt : "",
      placeholder: ["automyai OpenAI signup pool pending", "automyai OpenAI email rebind target pending"].includes(String(original.note || "")),
    });
  }
  return proofs;
}

function events(database: Db, accountId: string): Row[] {
  return database.prepare("SELECT * FROM lifecycle_events WHERE account_id=? ORDER BY id").all(accountId) as Row[];
}
function recycleRelations(database: Db, accountId: string): Row[] {
  return database.prepare("SELECT * FROM account_relations WHERE from_account_id=? AND relation_type='mailbox_recycle' ORDER BY id").all(accountId) as Row[];
}

export function buildBanAccessRepair(database: Db, proofs: LegacyLinkProof[], options: {
  includeUnbanned?: boolean;
  // Explicitly authorized account IDs only. This may acknowledge an older
  // deletion after a verified restoration; it never overrides reclaim/revoke.
  restoreAfterDeletion?: string[];
} = {}): BanAccessRepair {
  if (!Array.isArray(proofs) || proofs.length > 2000 || new Set(proofs.map((proof) => proof.grantId)).size !== proofs.length) throw new Error("ban_repair_invalid_proofs");
  const byGrant = new Map(proofs.map((proof) => [proof.grantId, proof]));
  const result: BanAccessRepair = { guards: [], eventGuards: [], relationGuards: [], changes: [], skipped: [], counts: {
    bannedGrants: 0, restoredLegacyLinks: 0, restoredBanWindows: 0, reopenedSales: 0, correctedHistoricalSales: 0, skipped: 0,
  } };
  const guard = (table: Table, record: Row) => {
    if (!result.guards.some((item) => item.table === table && item.id === record.id)) result.guards.push({ table, id: record.id, fingerprint: repairFingerprint(record) });
  };
  for (const grant of database.prepare("SELECT g.* FROM access_grants g JOIN gpt_accounts a ON a.id=g.account_id WHERE (?=1 OR a.deactivation_locked=1)").all(Number(options.includeUnbanned === true)) as Row[]) {
    result.counts.bannedGrants += 1;
    const proof = byGrant.get(grant.id), account = row(database, "gpt_accounts", grant.account_id)!, binding = row(database, "email_bindings", grant.binding_id);
    const history = events(database, grant.account_id);
    const relations = recycleRelations(database, grant.account_id);
    const restoredAfterDeletion = options.restoreAfterDeletion?.includes(account.id)
      ? Math.max(...history.filter(event => event.event_type === "account_restored"
        && ["operator-correction", "v2-admin"].includes(String(event.source)))
        .map(event => Date.parse(String(event.occurred_at || ""))).filter(Number.isFinite)) : NaN;
    const blocksAccess = (event: Row) => /(?:reclaim|revok|recycl|password|rotat|deleted)/i.test(String(event.event_type))
      && !(event.event_type === "account_deleted" && Number.isFinite(restoredAfterDeletion)
        && Date.parse(String(event.occurred_at || "")) < restoredAfterDeletion);
    let reason = !proof || !binding ? "original_customer_link_unproven"
      : proof.accountId !== grant.account_id || proof.bindingId !== binding.id || proof.legacyMappingId !== binding.legacy_mapping_id
        || proof.customerMaterialFingerprint !== customerMaterial(grant) ? "customer_material_changed"
      : account.source_status !== "current" ? "noncurrent_legacy_source"
      : account.retired_at || account.lifecycle_status === "retired" ? "explicit_retired_account"
      : account.deleted_at || account.lifecycle_status === "deleted" ? "account_deleted"
      : account.identity_status === "conflict" || account.lifecycle_status === "quarantined" || account.quarantine_reason ? "identity_or_business_quarantine"
      : proof.placeholder ? "unissued_placeholder"
      : proof.manualReclaimed || relations.length ? "explicit_legacy_reclaim"
      : binding.receive_disabled_at || proof.manualReceiveDisabled ? "explicit_receive_disabled"
      : (grant.revoke_reason && grant.revoke_reason !== "account_deactivated") || (grant.revoked_at && !grant.revoke_reason) ? "explicit_or_unknown_revocation"
      : !Number(grant.active) && grant.scope !== "admin_only" && grant.revoke_reason !== "account_deactivated" ? "inactive_origin_unproven"
      : history.some(blocksAccess) ? "explicit_customer_access_event" : "";
    if (!reason && grant.scope === "admin_only" && (Number(grant.active) !== 0 || grant.first_used_at || grant.revoked_at || grant.revoke_reason)) reason = "admin_only_origin_changed";
    if (reason) { result.skipped.push({ grantId: grant.id, reason }); continue; }
    const checkedProof = proof!, checkedBinding = binding!;
    let from: string, to: string;
    try {
      from = extreme([grant.visible_from, checkedBinding.valid_from, checkedProof.legacyFrom, checkedProof.restoredAt], "max");
      to = extreme([checkedBinding.valid_to, checkedProof.legacyTo], "min");
      if (to && from && Date.parse(to) <= Date.parse(from)) throw new Error("ban_repair_empty_window");
      if (!Number(checkedBinding.is_current) && !to) throw new Error("ban_repair_historical_end_unknown");
    } catch { result.skipped.push({ grantId: grant.id, reason: "ownership_window_unproven" }); continue; }
    const banAt = Date.parse(String(account.deactivated_at || ""));
    const automaticBanTimes = [banAt, ...history.filter((event) => event.event_type === "account_deactivated"
      && ["v1-shadow-import", "shared-mail-api-sync", "outlook-mail-sync"].includes(String(event.source)))
      .map((event) => Date.parse(String(event.occurred_at || "")))].filter(Number.isFinite);
    const matchesAutomaticBan = (time: number) => Number.isFinite(time) && automaticBanTimes.some((at) => time === at || time === at + 1);
    const currentEnd = Date.parse(String(grant.visible_to || ""));
    const banCutoff = matchesAutomaticBan(currentEnd);
    // Retain any earlier unexplained restriction. Only a proven automatic ban
    // cutoff can be widened to the separately verified binding/recycle end.
    if (grant.visible_to && !banCutoff) to = extreme([to, grant.visible_to], "min");
    const proposed = { ...grant, active: 1, scope: to ? "historical" : "current", visible_from: from, visible_to: to,
      revoked_at: grant.revoke_reason === "account_deactivated" ? "" : grant.revoked_at,
      revoke_reason: grant.revoke_reason === "account_deactivated" ? "" : grant.revoke_reason };
    if (repairFingerprint(proposed) !== repairFingerprint(grant)) {
      guard("gpt_accounts", account); guard("email_bindings", checkedBinding); guard("access_grants", grant);
      if (!result.eventGuards.some((item) => item.accountId === account.id)) result.eventGuards.push({ accountId: account.id, fingerprint: repairFingerprint(history) });
      if (!result.relationGuards.some((item) => item.accountId === account.id)) result.relationGuards.push({ accountId: account.id, fingerprint: repairFingerprint(relations) });
      result.changes.push({ table: "access_grants", id: grant.id, accountId: account.id,
        reason: grant.scope === "admin_only" ? "restore_original_legacy_customer_link" : "remove_automatic_ban_cutoff", before: grant, after: proposed });
      if (grant.scope === "admin_only" || !Number(grant.active)) result.counts.restoredLegacyLinks += 1;
      if (banCutoff && proposed.visible_to !== grant.visible_to) result.counts.restoredBanWindows += 1;
    }
    const sale = grant.sale_id ? row(database, "sales", grant.sale_id) : undefined;
    if (sale && sale.binding_id === grant.binding_id && sale.account_id === account.id && sale.end_reason === "account_deactivated"
      && !result.changes.some((item) => item.table === "sales" && item.id === sale.id)) {
      if (!matchesAutomaticBan(Date.parse(sale.ended_at))) {
        result.skipped.push({ grantId: grant.id, reason: "sale_closure_time_unproven" }); continue;
      }
      const historicalEnd = extreme([checkedBinding.valid_to, checkedProof.legacyTo], "min");
      const after = { ...sale, status: historicalEnd ? "closed" : "active", ended_at: historicalEnd,
        end_reason: historicalEnd ? checkedProof.legacyRetired ? "account_retired" : "binding_ended" : "" };
      guard("gpt_accounts", account); guard("email_bindings", checkedBinding); guard("sales", sale);
      if (!result.eventGuards.some((item) => item.accountId === account.id)) result.eventGuards.push({ accountId: account.id, fingerprint: repairFingerprint(history) });
      if (!result.relationGuards.some((item) => item.accountId === account.id)) result.relationGuards.push({ accountId: account.id, fingerprint: repairFingerprint(relations) });
      result.changes.push({ table: "sales", id: sale.id, accountId: account.id, reason: "remove_automatic_ban_sale_closure", before: sale, after });
      if (historicalEnd) result.counts.correctedHistoricalSales += 1; else result.counts.reopenedSales += 1;
    }
  }
  result.counts.skipped = result.skipped.length;
  return result;
}

export function applyBanAccessRepair(database: Db, reviewed: BanAccessRepair, beforeWrite?: (value: BanAccessRepair) => void): BanAccessRepair["counts"] {
  return database.transaction(() => {
    for (const guard of reviewed.guards) if (repairFingerprint(row(database, guard.table, guard.id) ?? null) !== guard.fingerprint) throw new Error("ban_repair_compare_and_swap_failed");
    for (const guard of reviewed.eventGuards) if (repairFingerprint(events(database, guard.accountId)) !== guard.fingerprint) throw new Error("ban_repair_events_changed");
    for (const guard of reviewed.relationGuards) if (repairFingerprint(recycleRelations(database, guard.accountId)) !== guard.fingerprint) throw new Error("ban_repair_relations_changed");
    beforeWrite?.(reviewed);
    const now = new Date().toISOString();
    for (const change of reviewed.changes) {
      if (change.table === "access_grants") {
        for (const key of ["id", "account_id", "binding_id", "public_token_hash", "public_token_enc", "password_hash", "password_plain_enc", "login_identifier_hash", "login_identifier_enc", "sale_id"])
          if (change.before[key] !== change.after[key]) throw new Error("ban_repair_customer_material_mutation");
        database.prepare("UPDATE access_grants SET active=?,scope=?,visible_from=?,visible_to=?,revoked_at=?,revoke_reason=?,updated_at=? WHERE id=?")
          .run(change.after.active, change.after.scope, change.after.visible_from, change.after.visible_to, change.after.revoked_at, change.after.revoke_reason, now, change.id);
      } else if (change.table === "sales") database.prepare("UPDATE sales SET status=?,ended_at=?,end_reason=?,updated_at=? WHERE id=?")
        .run(change.after.status, change.after.ended_at, change.after.end_reason, now, change.id);
      else throw new Error("ban_repair_invalid_mutation");
      database.prepare("INSERT INTO lifecycle_events(id,account_id,event_type,occurred_at,source,payload_json,created_at) VALUES(?,?,'customer_ban_access_repaired',?,'reviewed-ban-access-repair',?,?)")
        .run(crypto.randomUUID(), change.accountId, now, JSON.stringify({ recordType: change.table, recordId: change.id, reason: change.reason,
          bindingUnchanged: true, deactivationUnchanged: true }), now);
    }
    if ((database.pragma("foreign_key_check") as unknown[]).length) throw new Error("ban_repair_foreign_keys");
    return reviewed.counts;
  }).immediate();
}

function writeProtected(filename: string, value: unknown): void {
  const descriptor = fs.openSync(filename, "wx", 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2), options: Record<string, string> = {};
  let apply = false, includeUnbanned = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") { apply = true; continue; }
    if (args[i] === "--include-unbanned") { includeUnbanned = true; continue; }
    if (!["--database", "--legacy", "--env-file", "--report-directory", "--restore-after-deletion"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("ban_repair_invalid_arguments");
    options[args[i]] = args[++i];
  }
  for (const key of ["--database", "--legacy", "--env-file", "--report-directory"]) if (!options[key] || !path.isAbsolute(options[key])) throw new Error("ban_repair_explicit_paths_required");
  if (fs.statSync(options["--report-directory"]).mode & 0o077) throw new Error("ban_repair_report_directory_permissions");
  if (fs.statSync(options["--env-file"]).mode & 0o077) throw new Error("ban_repair_environment_permissions");
  process.env.ENV_FILE = options["--env-file"];
  const [{ decryptSecret, digestToken }, { emailHash }] = await Promise.all([import("../src/server/crypto.js"), import("../src/server/association.js")]);
  const database = new Database(fs.realpathSync(options["--database"]), { readonly: !apply, fileMustExist: true });
  try {
    const originals = JSON.parse(fs.readFileSync(options["--legacy"], "utf8")) as Row[];
    const proofs = createLegacyLinkProofs(database, originals, (grant, binding, original) => {
      const email = String(original.email || original.login || "").trim().toLowerCase();
      return Boolean(original.passwordPlain && original.passwordHash && Number(grant.legacy_public_token) === 1
        && grant.public_token_hash === digestToken(String(original.id)) && decryptSecret(grant.public_token_enc) === original.id
        && grant.password_hash === original.passwordHash && decryptSecret(grant.password_plain_enc) === original.passwordPlain
        && grant.login_identifier_hash === emailHash(email) && binding.email_hash === emailHash(email)
        && decryptSecret(grant.login_identifier_enc).toLowerCase() === email && decryptSecret(binding.email_enc).toLowerCase() === email);
    }, includeUnbanned);
    const previewFile = path.join(options["--report-directory"], "ban-access-repair-preview.json");
    // Apply exactly the saved, reviewable proposal. A newer grant/password,
    // binding or manual event must fail CAS instead of silently widening scope.
    const reviewed = apply ? JSON.parse(fs.readFileSync(previewFile, "utf8")) as BanAccessRepair
      : database.transaction(() => buildBanAccessRepair(database, proofs, { includeUnbanned, restoreAfterDeletion: options["--restore-after-deletion"] ? [options["--restore-after-deletion"]] : [] }))();
    const file = path.join(options["--report-directory"], apply ? "ban-access-repair-applied.json" : "ban-access-repair-preview.json");
    if (apply) {
      applyBanAccessRepair(database, reviewed, (value) => writeProtected(file, { state: "prepared", at: new Date().toISOString(), ...value }));
      writeProtected(file + ".committed", { state: "committed", at: new Date().toISOString(), counts: reviewed.counts });
    } else writeProtected(file, { state: "preview", at: new Date().toISOString(), scope: includeUnbanned ? "all-accounts" : "banned-accounts", restoreAfterDeletion: options["--restore-after-deletion"] || "", proofs, ...reviewed });
    process.stdout.write(`${JSON.stringify({ mode: apply ? "applied" : "preview", ...reviewed.counts })}\n`);
  } finally { database.close(); }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${/^ban_repair_[a-z_]+$/.test(error?.message || "") ? error.message : "ban_repair_failed"}\n`); process.exitCode = 1; });
}
