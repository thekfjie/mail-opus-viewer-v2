import fs from "node:fs";
import { config } from "./config.js";
import { syncFromV1 } from "./legacy-import.js";
import { syncSub2ApiAlive } from "./sub2api-sync.js";
import { refreshAutomaticTrialJobs, runAutomaticTrialChecks } from "./payment-exposure.js";

let previousSignature = "";
let lastSub2ApiSyncAt = 0;
let running = false;

function signature(): string {
  const paths = [config.v1ConfigFile, config.v1MailIndexFile].filter(Boolean);
  return paths.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${filePath}:missing`;
    }
  }).join("|");
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let v1: unknown = { skipped: true };
    let v1Changed = false;
    if (config.readOnly && config.v1ConfigFile) {
      const current = signature();
      v1Changed = current !== previousSignature;
      if (v1Changed) {
        v1 = syncFromV1();
        previousSignature = current;
      }
    }

    const now = Date.now();
    let sub2api: unknown = { skipped: true };
    const sub2ApiDue = config.readOnly && (v1Changed || now - lastSub2ApiSyncAt >= config.syncIntervalMs);
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
      trialJobs = await refreshAutomaticTrialJobs();
      trialSchedule = await runAutomaticTrialChecks();
    } catch (error) {
      trialSchedule = { error: error instanceof Error ? error.message : String(error) };
    }
    if (v1Changed || sub2ApiDue || (trialJobs as any)?.checked || (trialSchedule as any)?.candidates) {
      process.stdout.write(`[${new Date().toISOString()}] worker ${JSON.stringify({ v1, sub2api, trialJobs, trialSchedule })}\n`);
    }
  } catch (error) {
    process.stderr.write(`[${new Date().toISOString()}] worker failed ${error instanceof Error ? error.stack : String(error)}\n`);
  } finally {
    running = false;
  }
}

void run();
setInterval(() => void run(), config.syncIntervalMs);
