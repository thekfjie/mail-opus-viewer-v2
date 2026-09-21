import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { db } from "./db.js";
import { syncSub2ApiAlive } from "./sub2api-sync.js";
import { runPromotionQueue, scheduleDuePromotionChecks } from "./promotion.js";
import { retryPendingSharedMailEvents, syncOutlookMailboxes } from "./mail-sync.js";
import { refreshPendingPaymentExposureJobs } from "./payment-exposure.js";
import { InProcessTaskMutex, type TaskMutex } from "./infrastructure/task-mutex.js";

type WorkerDependencies = {
  now: () => number;
  outlook: typeof syncOutlookMailboxes;
  sub2api: typeof syncSub2ApiAlive;
  schedule: typeof scheduleDuePromotionChecks;
  promotions: typeof runPromotionQueue;
  pendingMail: typeof retryPendingSharedMailEvents;
  paymentExposure: typeof refreshPendingPaymentExposureJobs;
  taskMutex: TaskMutex;
};

export function createWorker(overrides: Partial<WorkerDependencies> = {}) {
  const dependencies: WorkerDependencies = {
    now: Date.now, outlook: syncOutlookMailboxes, sub2api: syncSub2ApiAlive,
    schedule: scheduleDuePromotionChecks, promotions: runPromotionQueue, pendingMail: retryPendingSharedMailEvents,
    paymentExposure: refreshPendingPaymentExposureJobs, ...overrides,
    taskMutex: overrides.taskMutex ?? new InProcessTaskMutex(),
  };
  let lastSub2ApiSyncAt = 0;
  let lastOutlookSyncAt = 0;
  let lastPendingMailAt = 0;
  const startedAt = new Date(dependencies.now()).toISOString();

  function heartbeat(detail: Record<string, unknown>, status = "ok"): void {
    let artifact = "";
    try {
      artifact = String(JSON.parse(fs.readFileSync(path.join(config.projectRoot, "dist/release-manifest.json"), "utf8")).artifactSha256 || "");
    } catch {}
    db.prepare(`INSERT INTO worker_heartbeats(worker_name,artifact_sha256,process_id,status,detail_json,heartbeat_at,started_at)
      VALUES('native-sync-worker',?,?,?,?,?,?)
      ON CONFLICT(worker_name) DO UPDATE SET artifact_sha256=excluded.artifact_sha256,
        process_id=excluded.process_id,status=excluded.status,detail_json=excluded.detail_json,
        heartbeat_at=excluded.heartbeat_at,started_at=excluded.started_at`).run(
      artifact, process.pid, status, JSON.stringify(detail), new Date(dependencies.now()).toISOString(), startedAt,
    );
  }

  async function runOnce(): Promise<Record<string, unknown>> {
    const execution = await dependencies.taskMutex.runExclusive("worker:native-sync", async () => {
      const detail: Record<string, unknown> = { sharedMail: { skipped: true, reason: "event_or_admin_trigger_only" } };
      const attempt = async (key: string, operation: () => unknown) => {
        try { detail[key] = await operation(); }
        catch { detail[key] = { error: "task_failed" }; }
      };
      const now = dependencies.now();
      if (!config.readOnly) {
        if (now - lastPendingMailAt >= config.pendingMailIntervalMs) {
          lastPendingMailAt = now;
          await attempt("pendingMail", dependencies.pendingMail);
        } else detail.pendingMail = { skipped: true, reason: "interval" };
        if (config.outlookMailSyncEnabled && now - lastOutlookSyncAt >= config.outlookSyncIntervalMs) {
          lastOutlookSyncAt = now;
          await attempt("outlookMail", dependencies.outlook);
        } else detail.outlookMail = { skipped: true };
        if (now - lastSub2ApiSyncAt >= config.syncIntervalMs) {
          lastSub2ApiSyncAt = now;
          await attempt("sub2api", dependencies.sub2api);
        }
        await attempt("trialSchedule", dependencies.schedule);
        await attempt("trialJobs", dependencies.promotions);
        await attempt("paymentExposureJobs", dependencies.paymentExposure);
      } else detail.tasks = { skipped: true, reason: "read_only" };
      heartbeat(detail, Object.values(detail).some((value: any) => value?.error) ? "degraded" : "ok");
      return detail;
    });
    return execution.acquired ? execution.value : { skipped: true, reason: "already_running" };
  }
  return { runOnce };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const worker = createWorker();
  const run = () => worker.runOnce().catch(() => process.stderr.write("worker cycle failed\n"));
  void run();
  setInterval(() => void run(), Math.min(config.syncIntervalMs, config.pendingMailIntervalMs));
}
