import crypto from "node:crypto";

export interface LegacyMapping {
  id: string;
  email?: string;
  login?: string;
  baseEmail?: string;
  recycleBaseEmail?: string;
  outlookManagerEmail?: string;
  domainMailbox?: boolean;
  lifecycleStatus?: string;
  recycledFromId?: string;
  recycledToId?: string;
  rebindPreviousId?: string;
  rebindNextId?: string;
  rebindChangedAt?: string;
  mailNotBefore?: string;
  mailNotAfter?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface LegacyRecord extends LegacyMapping {
  __sourceStatus: "current" | "recovered";
  __sourcePath: string;
  __synthetic?: boolean;
  __identityKey?: string;
}

export function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function splitEmail(value: unknown): { email: string; localPart: string; domain: string } {
  const email = normalizeEmail(value);
  const index = email.lastIndexOf("@");
  if (index <= 0 || index === email.length - 1) return { email, localPart: "", domain: "" };
  return { email, localPart: email.slice(0, index), domain: email.slice(index + 1) };
}

export function providerFor(record: LegacyMapping): string {
  const email = normalizeEmail(record.outlookManagerEmail || record.email || record.login);
  const domain = splitEmail(email).domain;
  if (record.outlookManagerEmail || /(?:outlook|hotmail|live)\./i.test(domain)) return "outlook";
  if (domain === "icloud.com" || domain.endsWith(".icloud.com")) return "icloud";
  if (record.domainMailbox) return "domain";
  return domain || "unknown";
}

export function stableId(namespace: string, ...parts: unknown[]): string {
  const hash = crypto.createHash("sha256").update(namespace).update("\0").update(parts.map(String).join("\0")).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function emailHash(email: string): string {
  return crypto.createHash("sha256").update(normalizeEmail(email)).digest("base64url");
}

export function isRoutingEndpoint(record: LegacyMapping, routingEmails: Set<string>): boolean {
  const email = normalizeEmail(record.email || record.login);
  if (routingEmails.has(email)) return true;
  const note = String(record.note || "").toLowerCase();
  return /(?:forwarding|转发落地|隐藏邮件落地|routing only)/.test(note);
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id) || id;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    if (!this.parent.has(left) || !this.parent.has(right)) return;
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    this.parent.set(a < b ? b : a, a < b ? a : b);
  }
}

export interface AssociationGraph {
  accountIdByLegacyId: Map<string, string>;
  groups: Map<string, LegacyRecord[]>;
  routingIds: Set<string>;
  inferredRebindPairs: Array<{ previousId: string; nextId: string; changedAt: string; method: string }>;
  conflicts: Array<{ recordIds: string[]; localPart: string; reason: string }>;
}

function timeValue(record: LegacyMapping): number {
  const value = Date.parse(String(record.mailNotBefore || record.createdAt || record.updatedAt || ""));
  return Number.isFinite(value) ? value : 0;
}

export function buildAssociationGraph(records: LegacyRecord[], routingEmails: Set<string>): AssociationGraph {
  const byId = new Map(records.map((record) => [String(record.id), record]));
  const dsu = new DisjointSet();
  const routingIds = new Set<string>();
  for (const record of records) {
    dsu.add(record.id);
    if (isRoutingEndpoint(record, routingEmails)) routingIds.add(record.id);
  }

  const inferredRebindPairs: AssociationGraph["inferredRebindPairs"] = [];
  const conflicts: AssociationGraph["conflicts"] = [];
  for (const record of records) {
    const nextId = String(record.rebindNextId || "");
    const previousId = String(record.rebindPreviousId || "");
    if (nextId && byId.has(nextId)) {
      dsu.union(record.id, nextId);
      inferredRebindPairs.push({
        previousId: record.id,
        nextId,
        changedAt: String(record.rebindChangedAt || byId.get(nextId)?.mailNotBefore || record.updatedAt || ""),
        method: "legacy_explicit_rebind",
      });
    }
    if (previousId && byId.has(previousId)) dsu.union(previousId, record.id);
  }

  const byIdentity = new Map<string, LegacyRecord[]>();
  for (const record of records) {
    if (!record.__identityKey || routingIds.has(record.id)) continue;
    const list = byIdentity.get(record.__identityKey) || [];
    list.push(record);
    byIdentity.set(record.__identityKey, list);
  }
  for (const list of byIdentity.values()) {
    if (list.length < 2) continue;
    const ordered = [...list].sort((a, b) => timeValue(a) - timeValue(b) || a.id.localeCompare(b.id));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const next = ordered[index];
      dsu.union(previous.id, next.id);
      if (normalizeEmail(previous.email || previous.login) !== normalizeEmail(next.email || next.login)) {
        inferredRebindPairs.push({
          previousId: previous.id,
          nextId: next.id,
          changedAt: String(next.mailNotBefore || next.createdAt || next.updatedAt || ""),
          method: "openai_identity_evidence",
        });
      }
    }
  }

  // Equal local-parts across trusted domains are mailbox-routing evidence,
  // not OpenAI identity evidence. A rebind group requires either explicit
  // reciprocal metadata or the same observed OpenAI identity. This prevents
  // a tokenless new-domain address from inheriting the old iCloud AT.
  const byLocalPart = new Map<string, LegacyRecord[]>();
  for (const record of records) {
    if (routingIds.has(record.id)) continue;
    const localPart = splitEmail(record.email || record.login).localPart;
    if (!localPart) continue;
    const list = byLocalPart.get(localPart) || [];
    list.push(record);
    byLocalPart.set(localPart, list);
  }
  for (const [localPart, list] of byLocalPart) {
    const current = list.filter((record) => record.__sourceStatus === "current");
    for (let index = 0; index < current.length; index += 1) {
      for (let peerIndex = index + 1; peerIndex < current.length; peerIndex += 1) {
        const left = current[index];
        const right = current[peerIndex];
        if (!left.__identityKey || !right.__identityKey || left.__identityKey === right.__identityKey) continue;
        conflicts.push({ recordIds: [left.id, right.id], localPart, reason: "同前缀记录具有不同OpenAI身份" });
      }
    }
  }

  const rootMembers = new Map<string, LegacyRecord[]>();
  for (const record of records) {
    if (routingIds.has(record.id)) continue;
    const root = dsu.find(record.id);
    const list = rootMembers.get(root) || [];
    list.push(record);
    rootMembers.set(root, list);
  }

  const groups = new Map<string, LegacyRecord[]>();
  const accountIdByLegacyId = new Map<string, string>();
  for (const members of rootMembers.values()) {
    const accountId = stableId("gpt-account", ...members.map((item) => item.id).sort());
    groups.set(accountId, members);
    for (const member of members) accountIdByLegacyId.set(member.id, accountId);
  }
  return { accountIdByLegacyId, groups, routingIds, inferredRebindPairs, conflicts };
}

export function parseJwtSubject(token: unknown): string {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return "";
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return String(payload.sub || payload.user_id || payload["https://api.openai.com/auth"]?.user_id || "");
  } catch {
    return "";
  }
}
