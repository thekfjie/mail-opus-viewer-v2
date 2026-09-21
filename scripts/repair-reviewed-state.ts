import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// Standalone: never import runtime configuration, migrations or upstream clients.
const FALSE_IDENTITY_REASON = "相同邮箱出现了不同OpenAI身份";
type Row = Record<string, any>;
type DatabaseHandle = Database.Database;

export interface ReviewedStatePlan {
  accountIds: string[];
  incident: { from: string; to: string };
}

interface Guard { table: string; id: string; fingerprint: string }
interface Patch { table: "gpt_accounts" | "access_grants" | "sales"; id: string; values: Row }
export interface ReviewedRepair {
  guards: Guard[];
  baselineGuards: Guard[];
  patches: Patch[];
  counts: { reviewedAccounts: number; restoredAccounts: number; restoredGrants: number; restoredSales: number; skippedAccounts: number; skippedGrants: number };
}

function fingerprint(row: Row | undefined): string {
  return crypto.createHash("sha256").update(JSON.stringify(row
    ? Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]])) : null)).digest("hex");
}

function read(database: DatabaseHandle, table: string, id: string): Row | undefined {
  if (!["gpt_accounts", "access_grants", "email_bindings", "sales"].includes(table)) throw new Error("repair_invalid_table");
  return database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Row | undefined;
}

function equalExcept(left: Row | undefined, right: Row | undefined, ignored: Set<string>): boolean {
  if (!left || !right) return left === right;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .every((key) => ignored.has(key) || left[key] === right[key]);
}

const accountIncidentFields = new Set(["identity_status", "lifecycle_status", "quarantined_at", "quarantine_reason", "updated_at"]);
const grantIncidentFields = new Set(["active", "revoked_at", "revoke_reason", "updated_at"]);

function preservedDeactivation(database: DatabaseHandle, accountId: string, incidentTo: number): boolean {
  const account = read(database, "gpt_accounts", accountId);
  if (!account || account.lifecycle_status !== "deactivated" || !Number(account.deactivation_locked)) return false;
  const deactivatedAt = Date.parse(String(account.deactivated_at || ""));
  if (!Number.isFinite(deactivatedAt) || deactivatedAt < incidentTo) return false;
  const events = database.prepare("SELECT occurred_at, payload_json FROM lifecycle_events WHERE account_id=? AND event_type='account_deactivated'").all(accountId) as Row[];
  return events.some((event) => {
    const occurredAt = Date.parse(String(event.occurred_at || ""));
    if (!Number.isFinite(occurredAt) || occurredAt < incidentTo) return false;
    try { return JSON.parse(String(event.payload_json || "{}")).customerAccessPreserved === true; } catch { return false; }
  });
}

export function buildRepair(database: DatabaseHandle, baseline: DatabaseHandle, plan: ReviewedStatePlan): ReviewedRepair {
  const from = Date.parse(plan?.incident?.from);
  const to = Date.parse(plan?.incident?.to);
  if (!Array.isArray(plan?.accountIds) || plan.accountIds.length > 100
    || plan.accountIds.some((id) => typeof id !== "string" || !id || id.length > 128)
    || new Set(plan.accountIds).size !== plan.accountIds.length
    || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 5 * 60_000) {
    throw new Error("repair_invalid_review_plan");
  }
  const incidentTime = (value: unknown) => { const at = Date.parse(String(value || "")); return at >= from && at < to; };
  const result: ReviewedRepair = { guards: [], baselineGuards: [], patches: [],
    counts: { reviewedAccounts: plan.accountIds.length, restoredAccounts: 0, restoredGrants: 0, restoredSales: 0, skippedAccounts: 0, skippedGrants: 0 } };
  const guard = (target: Guard[], table: string, id: string, row: Row | undefined) => {
    if (!target.some((item) => item.table === table && item.id === id)) target.push({ table, id, fingerprint: fingerprint(row) });
  };
  for (const accountId of plan.accountIds) {
    const current = read(database, "gpt_accounts", accountId);
    const original = read(baseline, "gpt_accounts", accountId);
    if (!current || !original || current.identity_status !== "conflict" || original.identity_status !== "confirmed"
      || current.quarantine_reason !== FALSE_IDENTITY_REASON || original.quarantine_reason === FALSE_IDENTITY_REASON
      || (!incidentTime(current.updated_at) && !incidentTime(current.quarantined_at))) {
      result.counts.skippedAccounts += 1; continue;
    }
    if (Number(original.deactivation_locked) && !Number(current.deactivation_locked)) throw new Error("repair_deactivation_lock_regressed");
    guard(result.guards, "gpt_accounts", accountId, current);
    guard(result.baselineGuards, "gpt_accounts", accountId, original);
    // Never copy lock/date/sold/credentials from a snapshot. A later terminal
    // transition remains authoritative even when the identity alarm was false.
    const terminal = current.deleted_at || ["retired", "deleted"].includes(current.lifecycle_status);
    const lifecycle = Number(current.deactivation_locked) || current.lifecycle_status === "deactivated"
      ? "deactivated" : terminal ? current.lifecycle_status : original.lifecycle_status;
    result.patches.push({ table: "gpt_accounts", id: accountId, values: {
      identity_status: "confirmed", lifecycle_status: lifecycle,
      quarantined_at: original.quarantined_at, quarantine_reason: original.quarantine_reason,
    } });
    result.counts.restoredAccounts += 1;

    const grants = database.prepare("SELECT * FROM access_grants WHERE account_id=? AND active=0 AND revoke_reason='identity_conflict'").all(accountId) as Row[];
    for (const grant of grants) {
      const before = read(baseline, "access_grants", grant.id);
      const binding = read(database, "email_bindings", grant.binding_id);
      const beforeBinding = read(baseline, "email_bindings", grant.binding_id);
      const sale = grant.sale_id ? read(database, "sales", grant.sale_id) : undefined;
      const beforeSale = grant.sale_id ? read(baseline, "sales", grant.sale_id) : undefined;
      const end = Date.parse(String(grant.visible_to || ""));
      const start = Date.parse(String(grant.visible_from || ""));
      const historicalWindow = before?.scope === "historical" && grant.scope === "historical"
        && Number.isFinite(end) && (!Number.isFinite(start) || end > start);
      const currentWindow = before?.scope === "current" && grant.scope === "current"
        && !grant.visible_to && !before.visible_to && Number(binding?.is_current) === 1 && Number(beforeBinding?.is_current) === 1;
      const saleUnchanged = !grant.sale_id || (sale && beforeSale && equalExcept(sale, beforeSale, new Set()));
      const saleIncidentOverlay = Boolean(grant.sale_id && sale && beforeSale
        && beforeSale.status === "active" && !beforeSale.ended_at && !beforeSale.end_reason
        && sale.status === "closed" && sale.end_reason === "identity_conflict"
        && incidentTime(sale.ended_at) && sale.updated_at === sale.ended_at
        && equalExcept(sale, beforeSale, new Set(["status", "ended_at", "end_reason", "updated_at"])));
      const accountStateUnchanged = equalExcept(current, original, accountIncidentFields)
        || (preservedDeactivation(database, accountId, to)
          && equalExcept(current, original, new Set([...accountIncidentFields, "deactivation_locked", "deactivated_at"])));
      const unchanged = before && Number(before.active) === 1 && (historicalWindow || currentWindow)
        && before.revoke_reason === "" && before.revoked_at === ""
        && incidentTime(grant.revoked_at) && grant.updated_at === grant.revoked_at
        && equalExcept(grant, before, grantIncidentFields)
        && accountStateUnchanged
        && binding?.account_id === accountId && beforeBinding?.account_id === accountId
        && equalExcept(binding, beforeBinding, new Set())
        && (saleUnchanged || saleIncidentOverlay);
      if (!unchanged) { result.counts.skippedGrants += 1; continue; }
      for (const [table, id, live, old] of [
        ["access_grants", grant.id, grant, before], ["email_bindings", grant.binding_id, binding, beforeBinding],
        ...(grant.sale_id ? [["sales", grant.sale_id, sale, beforeSale]] : []),
      ] as Array<[string, string, Row | undefined, Row | undefined]>) {
        guard(result.guards, table, id, live); guard(result.baselineGuards, table, id, old);
      }
      if (saleIncidentOverlay && sale && beforeSale) {
        if (!result.patches.some((item) => item.table === "sales" && item.id === grant.sale_id)) {
          result.patches.push({ table: "sales", id: grant.sale_id, values: {
            status: beforeSale.status, ended_at: beforeSale.ended_at, end_reason: beforeSale.end_reason,
          } });
          result.counts.restoredSales += 1;
        }
      }
      result.patches.push({ table: "access_grants", id: grant.id, values: { active: 1, revoked_at: "", revoke_reason: "" } });
      result.counts.restoredGrants += 1;
    }
  }
  return result;
}

export function applyRepair(database: DatabaseHandle, baseline: DatabaseHandle, plan: ReviewedStatePlan, reviewed = buildRepair(database, baseline, plan)): ReviewedRepair["counts"] {
  return database.transaction(() => {
    // Compare the exact reviewed rows under the write lock before any mutation.
    for (const [handle, guards] of [[database, reviewed.guards], [baseline, reviewed.baselineGuards]] as const) {
      for (const item of guards) if (fingerprint(read(handle, item.table, item.id)) !== item.fingerprint) {
        throw new Error("repair_compare_and_swap_failed");
      }
    }
    const fresh = buildRepair(database, baseline, plan);
    if (fingerprint(fresh as unknown as Row) !== fingerprint(reviewed as unknown as Row)) throw new Error("repair_review_changed");
    const now = new Date().toISOString();
    for (const patch of fresh.patches) {
      const fields = Object.keys(patch.values);
      const changed = database.prepare(`UPDATE ${patch.table} SET ${fields.map((field) => `${field}=?`).join(",")},updated_at=? WHERE id=?`)
        .run(...fields.map((field) => patch.values[field]), now, patch.id).changes;
      if (changed !== 1) throw new Error("repair_compare_and_swap_failed");
    }
    for (const patch of fresh.patches.filter((item) => item.table === "gpt_accounts")) {
      database.prepare(`INSERT INTO lifecycle_events(id,account_id,event_type,occurred_at,source,payload_json,created_at)
        VALUES(?,?,'identity_review_repaired',?,'reviewed-state-repair',?,?)`).run(
        crypto.randomUUID(), patch.id, now, JSON.stringify({ rule: "same_credential_identity_aliases", preservedBusinessState: true,
          restoredHistoricalGrants: fresh.patches.filter((item) => item.table === "access_grants"
            && (read(database, "access_grants", item.id)?.account_id === patch.id)
            && read(database, "access_grants", item.id)?.scope === "historical").length,
          restoredCurrentGrants: fresh.patches.filter((item) => item.table === "access_grants"
            && (read(database, "access_grants", item.id)?.account_id === patch.id)
            && read(database, "access_grants", item.id)?.scope === "current").length,
          restoredSales: fresh.patches.filter((item) => item.table === "sales"
            && (read(database, "sales", item.id)?.account_id === patch.id)).length }), now,
      );
    }
    if ((database.pragma("foreign_key_check") as unknown[]).length) throw new Error("repair_foreign_key_check_failed");
    return fresh.counts;
  }).immediate();
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowed = new Set(["--database", "--baseline", "--plan", "--apply"]);
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error("repair_invalid_arguments");
    if (args[i] === "--apply") continue;
    const key = args[i]; if (values[key] || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("repair_invalid_arguments");
    values[key] = args[++i];
  }
  if (!["--database", "--baseline", "--plan"].every((key) => values[key] && path.isAbsolute(values[key]))) {
    throw new Error("repair_requires_explicit_absolute_paths");
  }
  const databaseFile = fs.realpathSync(values["--database"]);
  const baselineFile = fs.realpathSync(values["--baseline"]);
  if (databaseFile === baselineFile) throw new Error("repair_baseline_must_be_distinct");
  const plan = JSON.parse(fs.readFileSync(values["--plan"], "utf8")) as ReviewedStatePlan;
  const baseline = new Database(baselineFile, { readonly: true, fileMustExist: true });
  const database = new Database(databaseFile, { readonly: !apply, fileMustExist: true });
  try {
    database.pragma("busy_timeout=5000");
    const reviewed = buildRepair(database, baseline, plan);
    const counts = apply ? applyRepair(database, baseline, plan, reviewed) : reviewed.counts;
    process.stdout.write(`${JSON.stringify({ mode: apply ? "applied" : "dry-run", ...counts })}\n`);
  } finally { database.close(); baseline.close(); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    const code = error instanceof Error && /^repair_[a-z_]+$/.test(error.message) ? error.message : "repair_failed";
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  }
}
