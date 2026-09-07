import { migrationReport } from "../src/server/repository.js";
import { db } from "../src/server/db.js";
import { config } from "../src/server/config.js";

const report = migrationReport() as any;
const audit = report.audit || {};
const critical = {
  integrity: report.integrity === "ok",
  foreignKeys: Number(report.foreignKeyViolations || 0) === 0,
  activeBindings: Number(audit.activeWithoutCurrentBinding || 0) === 0,
  selfRelations: Number(audit.selfReferentialAccountRelations || 0) === 0,
  multipleCurrentBindings: Number(audit.accountsWithMultipleCurrentBindings || 0) === 0,
  duplicateCurrentEmail: Number(audit.duplicateCurrentEmailAcrossAccounts || 0) === 0,
  ambiguousCustomerMail: Number(audit.ambiguousCustomerVisibleMessages || 0) === 0,
  credentialPointers: Number(audit.credentialPointerAccountMismatch || 0) === 0
    && Number(audit.credentialMaterialWithoutCurrentPointer || 0) === 0,
  promotionErrorsClassified: Number(audit.promotionRetryJobsWithBlankError || 0) === 0,
  promotionQueueNotRunning: Number(audit.promotionRunningJobs || 0) === 0,
  outboxCaughtUp: Number(audit.outboxLagBytes || 0) === 0,
  workerHeartbeatFresh: Number(audit.workerHeartbeatAgeSeconds || -1) >= 0
    && Number(audit.workerHeartbeatAgeSeconds || -1) <= Math.max(180, Math.ceil(config.syncIntervalMs / 1_000) * 3),
  apiWorkerArtifactMatch: audit.apiWorkerArtifactMatch === true,
};
const output = { generatedAt: new Date().toISOString(), ok: Object.values(critical).every(Boolean), critical, ...report };
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
db.close();
if (!output.ok) process.exitCode = 2;
