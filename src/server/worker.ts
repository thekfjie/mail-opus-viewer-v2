import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { syncSub2ApiAlive } from "./sub2api-sync.js";
import { runPromotionQueue, scheduleDuePromotionChecks } from "./promotion.js";
import { syncOutlookMailboxes, syncSharedMail } from "./mail-sync.js";
import { legacyConfig } from "./legacy-config.js";
import { syncFromV1 } from "./legacy-import.js";

let lastSub2ApiSyncAt = 0;
let lastSharedMailSyncAt = 0;
let lastOutlookSyncAt = 0;
let running = false;
const workerStartedAt = new Date().toISOString();
let lastV1ProjectionSignature = "";

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function v1ProjectionSignature(): string {
  return [legacyConfig.configFile, legacyConfig.mailIndexFile].map(fileSignature).join("|");
}

function refreshV1Projection(): Record<string, unknown> {
  if (config.accountAuthority !== "v1") return { skipped: true, reason: "v2_authority" };
  const signature = v1ProjectionSignature();
  if (signature === lastV1ProjectionSignature) return { skipped: true, reason: "unchanged" };
  const result = syncFromV1();
  lastV1ProjectionSignature = v1ProjectionSignature();
  return { synced: true, ...result };
}

function artifactSha256(): string {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(config.projectRoot, "dist/release-manifest.json"), "utf8"));
    return String(value.artifactSha256 || "");
  } catch { return ""; }
}

function heartbeat(detail: Record<string, unknown>, status = "ok"): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO worker_heartbeats(worker_name, artifact_sha256, process_id, status, detail_json, heartbeat_at, started_at)
    VALUES('native-sync-worker', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(worker_name) DO UPDATE SET artifact_sha256=excluded.artifact_sha256,
      process_id=excluded.process_id, status=excluded.status, detail_json=excluded.detail_json,
      heartbeat_at=excluded.heartbeat_at, started_at=excluded.started_at`).run(
    artifactSha256(), process.pid, status, JSON.stringify(detail), now, workerStartedAt,
  );
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    let sharedMail: unknown = { skipped: true };
    let outlookMail: unknown = { skipped: true };
    let v1Projection: unknown = { skipped: true };
    heartbeat({ state: "starting", v1Projection, sharedMail: { skipped: true }, outlookMail: { skipped: true } }, "starting");
    try {
      v1Projection = refreshV1Projection();
    } catch (error) {
      v1Projection = { error: error instanceof Error ? error.message : String(error) };
    }
    if (config.sharedMailSyncEnabled && now - lastSharedMailSyncAt >= config.sharedMailSyncIntervalMs) {
      lastSharedMailSyncAt = now;
      try {
        sharedMail = await syncSharedMail();
      } catch (error) {
        sharedMail = { error: error instanceof Error ? error.message : String(error) };
      }
    } else if (!config.sharedMailSyncEnabled) {
      sharedMail = { skipped: true, reason: "disabled_to_preserve_upstream_quota" };
    }
    if (config.outlookMailSyncEnabled && now - lastOutlookSyncAt >= config.outlookSyncIntervalMs) {
      lastOutlookSyncAt = now;
      try {
        outlookMail = await syncOutlookMailboxes();
      } catch (error) {
        outlookMail = { error: error instanceof Error ? error.message : String(error) };
      }
    } else if (!config.outlookMailSyncEnabled) {
      outlookMail = { skipped: true, reason: "disabled_to_preserve_mail_capacity" };
    }
    let sub2api: unknown = { skipped: true };
    const sub2ApiDue = now - lastSub2ApiSyncAt >= config.syncIntervalMs;
    if (sub2ApiDue) {
      lastSub2ApiSyncAt = now;
      try {
        sub2api = await syncSub2ApiAlive();
      } catch (error) {
        sub2api = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    let trialJobs: unknown = { skipped: true };
    let trialSchedule: unknown = { skipped: true };
    try {
      trialSchedule = scheduleDuePromotionChecks();
      trialJobs = await runPromotionQueue();
    } catch (error) {
      trialSchedule = { error: error instanceof Error ? error.message : String(error) };
    }
    heartbeat({ v1Projection, sharedMail, outlookMail, sub2api, trialJobs, trialSchedule });
    if ((v1Projection as any)?.synced || (v1Projection as any)?.error || sub2ApiDue || (sharedMail as any)?.fetched || (outlookMail as any)?.inserted || (trialJobs as any)?.checked || (trialSchedule as any)?.queued) {
      process.stdout.write(`[${new Date().toISOString()}] worker ${JSON.stringify({ v1Projection, sharedMail, outlookMail, sub2api, trialJobs, trialSchedule })}\n`);
    }
  } catch (error) {
    heartbeat({ error: error instanceof Error ? error.message : String(error) }, "error");
    process.stderr.write(`[${new Date().toISOString()}] native sync failed ${error instanceof Error ? error.stack : String(error)}\n`);
  } finally {
    running = false;
  }
}

void run();
setInterval(() => void run(), config.syncIntervalMs);
