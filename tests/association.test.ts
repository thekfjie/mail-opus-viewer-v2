import assert from "node:assert/strict";
import test from "node:test";
import { buildAssociationGraph, LegacyRecord } from "../src/server/association.js";

function record(id: string, email: string, extra: Partial<LegacyRecord> = {}): LegacyRecord {
  return { id, email, createdAt: `2026-08-${String(Number(id.replace(/\D/g, "") || 1)).padStart(2, "0")}T00:00:00.000Z`, __sourceStatus: "current", __sourcePath: "/current", ...extra };
}

test("完整本地部分相同但没有身份或显式关系时保持两个账号", () => {
  const graph = buildAssociationGraph([
    record("1", "okays_hymn.8n@icloud.com"),
    record("2", "okays_hymn.8n@ai-mail.tech"),
  ], new Set());
  assert.equal(graph.groups.size, 2);
  assert.equal(graph.inferredRebindPairs.length, 0);
});

test("不同+oai后缀永远不能按基础前缀合并", () => {
  const graph = buildAssociationGraph([
    record("1", "todo.leavers_0u+oaiqaparr@icloud.com"),
    record("2", "todo.leavers_0u+oaizgumpg@ai-mail.tech"),
  ], new Set());
  assert.equal(graph.groups.size, 2);
  assert.equal(graph.inferredRebindPairs.length, 0);
});

test("转发落地地址先排除，不参与同名自动关联", () => {
  const graph = buildAssociationGraph([
    record("1", "relay@routing.example.net"),
    record("2", "relay@example.net"),
  ], new Set(["relay@routing.example.net", "relay@example.net"]));
  assert.equal(graph.groups.size, 0);
  assert.equal(graph.routingIds.size, 2);
});

test("历史 mail 别名显式列入路由集合时同样不参与账号关联", () => {
  const graph = buildAssociationGraph([
    record("1", "archive-relay@example.net"),
    record("2", "mail@other.example"),
  ], new Set(["archive-relay@example.net"]));
  assert.equal(graph.groups.size, 1);
  assert.equal(graph.routingIds.size, 1);
  assert.equal(graph.groups.has("1"), false);
});

test("只有备份中找回的同名记录不会静默并入当前账号", () => {
  const graph = buildAssociationGraph([
    record("1", "name@icloud.com"),
    record("2", "name@ai-mail.tech", { __sourceStatus: "recovered", __sourcePath: "/backup" }),
  ], new Set());
  assert.equal(graph.groups.size, 2);
});

test("显式改绑关系优先，可关联备份恢复记录", () => {
  const graph = buildAssociationGraph([
    record("1", "name@icloud.com", { rebindNextId: "2", rebindChangedAt: "2026-08-21T00:00:00.000Z" }),
    record("2", "name@ai-mail.tech", { __sourceStatus: "recovered", __sourcePath: "/backup", rebindPreviousId: "1" }),
  ], new Set());
  assert.equal(graph.groups.size, 1);
  assert.equal(graph.inferredRebindPairs[0]?.method, "legacy_explicit_rebind");
});

test("可信域同前缀但OpenAI身份冲突时禁止合并", () => {
  const graph = buildAssociationGraph([
    record("1", "same@icloud.com", { __identityKey: "identity-a" }),
    record("2", "same@ai-mail.tech", { __identityKey: "identity-b" }),
  ], new Set());
  assert.equal(graph.groups.size, 2);
  assert.equal(graph.inferredRebindPairs.length, 0);
  assert.equal(graph.conflicts.length, 1);
});

test("回收前后即使同前缀也不能重新合并", () => {
  const graph = buildAssociationGraph([
    record("1", "same@icloud.com", { recycledToId: "2" }),
    record("2", "same@ai-mail.tech", { recycledFromId: "1" }),
  ], new Set());
  assert.equal(graph.groups.size, 2);
  assert.equal(graph.inferredRebindPairs.length, 0);
});

test("Outlook与自有域不依靠同前缀自动合并", () => {
  const graph = buildAssociationGraph([
    record("1", "same@outlook.com"),
    record("2", "same@kfjie.me"),
  ], new Set());
  assert.equal(graph.groups.size, 2);
});
