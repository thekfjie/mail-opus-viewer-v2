import { asyncMap } from '../src/server/async-collections.js';
import assert from "node:assert/strict";
import path from "node:path";

const databasePath = path.resolve(String(process.env.BATCH_VALIDATION_DATABASE_PATH || ""));
const productionPath = path.resolve("/var/lib/mail-opus-v2/mail-opus-v2.sqlite");
if (!process.env.BATCH_VALIDATION_DATABASE_PATH) throw new Error("BATCH_VALIDATION_DATABASE_PATH is required");
if (databasePath === productionPath) throw new Error("refusing to run mailbox batch validation against production database");

process.env.DATABASE_PATH = databasePath;
process.env.PROJECT_ROOT ||= path.resolve(".");
process.env.ENV_FILE ||= "/dev/null";
process.env.V2_SESSION_SECRET ||= "mailbox-batch-validation-session";
process.env.CREDENTIAL_ENCRYPTION_KEY ||= "mailbox-batch-validation-encryption";
process.env.V2_CF_D1_READ_TOKEN = "";

const [{ db }, { encryptSecret }, association, mail, transitions, repository, batch] = await Promise.all([
  import("../src/server/db.js"),
  import("../src/server/crypto.js"),
  import("../src/server/association.js"),
  import("../src/server/mail-sync.js"),
  import("../src/server/account-transitions.js"),
  import("../src/server/repository.js"),
  import("../src/server/mailbox-batch.js"),
]);

const runId = `batch-validation-${process.pid}-${Date.now()}`;
const baseLocal = `repro-${process.pid}-${Date.now()}`;
const baseAddress = `${baseLocal}@icloud.com`;
const aliases = ["one", "two", "three"].map((suffix) => `${baseLocal}+oai${suffix}@icloud.com`);
const replacementAlias = `${baseLocal}+oaifour@icloud.com`;
const otherBase = `${baseLocal}-separate@icloud.com`;
const otherAlias = `${baseLocal}-separate+oaione@icloud.com`;
const transportAddress = `${baseLocal}@example.invalid`;
const sender = "noreply@openai.com";
const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const deliveredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const mailSequenceBase = Date.now() * 10;
const providerIds = new Map<string, string>();
const labelByProviderId = new Map<string, string>();
for (const [index, label] of ["base", "alias-one", "alias-two", "alias-three", "unclear", "separate", "post-recycle-base"].entries()) {
  const providerId = String(mailSequenceBase + index + 1);
  providerIds.set(label, providerId);
  labelByProviderId.set(providerId, label);
}

function regex(value: string): string {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

async function addAccount(index: number, email: string, familyId: string): Promise<{ accountId: string; bindingId: string }> {
  const accountId = `${runId}-account-${index}`;
  const bindingId = `${runId}-binding-${index}`;
  const parts = association.splitEmail(email);
  (await db.prepare(`INSERT INTO gpt_accounts(id,lifecycle_status,source_status,arrived_at,created_at,updated_at)
    VALUES(?,'active','v2',?,?,?)`).run(accountId, startedAt, startedAt, startedAt));
  (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
    valid_from,is_current,association_method,legacy_mapping_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'icloud',?,1,'batch_validation',?,?,?)`).run(
    bindingId, accountId, familyId, encryptSecret(email), association.emailHash(email), parts.localPart, parts.domain,
    startedAt, `${runId}-legacy-${index}`, startedAt, startedAt,
  ));
  (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,sender_pattern,recipient_pattern,valid_from,source,created_at,updated_at)
    VALUES(?,?,?,?,?,'batch-validation',?,?)`).run(
    `${runId}-rule-${index}`, bindingId, regex(sender), regex(email), startedAt, startedAt, startedAt,
  ));
  return { accountId, bindingId };
}

const familyId = `${runId}-family`;
(await db.prepare(`INSERT INTO mailbox_families(id,provider,canonical_address_enc,canonical_address_hash,created_at,updated_at)
  VALUES(?,'icloud',?,?,?,?)`).run(
  familyId, encryptSecret(baseAddress), association.emailHash(baseAddress), startedAt, startedAt,
));
const children = (await asyncMap(aliases, async (email, index) => (await addAccount(index + 1, email, familyId))));
const otherFamilyId = `${runId}-other-family`;
(await db.prepare(`INSERT INTO mailbox_families(id,provider,canonical_address_enc,canonical_address_hash,created_at,updated_at)
  VALUES(?,'icloud',?,?,?,?)`).run(
  otherFamilyId, encryptSecret(otherBase), association.emailHash(otherBase), startedAt, startedAt,
));
const other = (await addAccount(9, otherAlias, otherFamilyId));

const grants = (await asyncMap(children, async (child, index) => (await transitions.issueCustomerGrant(child.accountId, child.bindingId, {
  trackSale: false, password: `validation-password-${index + 1}`,
}))));
const otherGrant = (await transitions.issueCustomerGrant(other.accountId, other.bindingId, {
  trackSale: false, password: "validation-password-other",
}));

function raw(recipient: string, subject: string): string {
  return `From: Validation <${sender}>\r\nTo: ${recipient}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nvalidation body`;
}

async function deliver(label: string, recipient: string, at = deliveredAt) {
  return mail.ingestSharedMailEvent({ id: providerIds.get(label), address: recipient, created_at: at, raw: raw(recipient, label) });
}

const deliveries = [
  ["base", baseAddress],
  ["alias-one", aliases[0]],
  ["alias-two", aliases[1]],
  ["alias-three", aliases[2]],
] as const;
const firstResults = [];
for (const [label, recipient] of deliveries) firstResults.push({ label, result: await deliver(label, recipient) });
const unclear = await deliver("unclear", transportAddress);
const separate = await deliver("separate", otherAlias);
const duplicate = await deliver("base", baseAddress);

const messageId = (label: string) => association.stableId("mail-message", "shared-mail-api", providerIds.get(label));
const providerId = async (id: string) => String(((await db.prepare("SELECT provider_message_id FROM mail_messages WHERE id=?").get(id)) as any)?.provider_message_id || "");
const visibleLabels = async (grantId: string) => {
  const grant = (await repository.grantById(grantId));
  assert.ok(grant);
  return new Set((await asyncMap((await repository.listCustomerMails(grant, 0, 100)).results, async (item: any) => await providerId(String(item.id)))).filter((id: string) => labelByProviderId.has(id))
    .map((id: string) => labelByProviderId.get(id)!));
};

for (const { result } of firstResults) assert.deepEqual({ inserted: result.inserted, claims: result.claims }, { inserted: true, claims: 3 });
assert.deepEqual({ inserted: unclear.inserted, claims: unclear.claims }, { inserted: true, claims: 0 });
assert.deepEqual({ inserted: separate.inserted, claims: separate.claims }, { inserted: true, claims: 1 });
assert.deepEqual({ inserted: duplicate.inserted, claims: duplicate.claims }, { inserted: false, claims: 0 });
assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_messages WHERE provider_message_id=?").get(providerIds.get("base"))) as any).n, 1);
assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_ownership_claims WHERE message_id=?").get(messageId("base"))) as any).n, 3);
assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_ownership_claims WHERE message_id=?").get(messageId("unclear"))) as any).n, 0);

const sharedBefore = new Set(["base", "alias-one", "alias-two", "alias-three"]);
for (const grant of grants) assert.deepEqual((await visibleLabels(grant.grantId)), sharedBefore);
assert.deepEqual((await visibleLabels(otherGrant.grantId)), new Set(["separate"]));

const recycled = (await transitions.recycleAccountTransition(children[0].accountId, replacementAlias, "free", "batch-validation"));
assert.equal((await repository.grantById(grants[0].grantId)), null);
const replacementBinding = (await db.prepare("SELECT id,valid_from FROM email_bindings WHERE account_id=? AND is_current=1").get(recycled.replacementId)) as any;
const replacementGrant = (await transitions.issueCustomerGrant(recycled.replacementId, String(replacementBinding.id), {
  trackSale: false, password: "validation-password-replacement",
}));
const postRecycleAt = new Date(Date.parse(String(replacementBinding.valid_from)) + 1000).toISOString();
const postRecycle = await deliver("post-recycle-base", baseAddress, postRecycleAt);
assert.deepEqual({ inserted: postRecycle.inserted, claims: postRecycle.claims }, { inserted: true, claims: 3 });
for (const grant of grants.slice(1)) assert.ok((await visibleLabels(grant.grantId)).has("post-recycle-base"));
assert.deepEqual((await visibleLabels(replacementGrant.grantId)), new Set(["post-recycle-base"]));
assert.ok(!(await visibleLabels(otherGrant.grantId)).has("post-recycle-base"));

const normalized = aliases.map(batch.mailboxBatchKey);
assert.equal(new Set([...normalized, batch.mailboxBatchKey(baseAddress), batch.mailboxBatchKey(replacementAlias)]).size, 1);
assert.notEqual(batch.mailboxBatchKey(otherAlias), normalized[0]);

const result = {
  ok: true,
  databaseKind: "non-production-copy",
  normalization: { sameBatchAddresses: 5, normalizedBatchCount: 1, differentBatchCount: 1 },
  cases: {
    base: { inserted: true, claims: 3, visibleToBatchChildren: 3 },
    aliases: { delivered: 3, claimsPerMessage: 3, visibleToBatchChildren: 3 },
    unclear: { inserted: true, claims: 0, customerVisible: false },
    separateBatch: { inserted: true, ownBatchVisible: true, firstBatchVisible: false },
    duplicate: { secondInsert: false, storedRows: 1, claims: 0 },
    manualRecycle: { oldGrantRevoked: true, survivingChildrenSeeNewMail: 2,
      replacementSeesPreRecycleMail: false, replacementSeesPostRecycleMail: true, separateBatchVisible: false },
  },
  integrity: db.pragma("integrity_check", { simple: true }),
  foreignKeyViolations: db.pragma("foreign_key_check").length,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
(await db.close());
