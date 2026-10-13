import fs from "node:fs";
import { db } from "./db.js";
import { legacyConfig } from "./legacy-config.js";

type JsonObject = Record<string, any>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export async function consumeV1Outbox(): Promise<{ consumed: number; cursor: number; reset: boolean }> {
  let stat: fs.Stats;
  try { stat = fs.statSync(legacyConfig.changeOutboxFile); }
  catch { return { consumed: 0, cursor: 0, reset: false }; }
  const state = (await db.prepare("SELECT source_cursor FROM sync_consumers WHERE consumer='v2-from-v1-outbox'").get()) as any;
  let cursor = Math.max(0, Number(state?.source_cursor || 0));
  let reset = false;
  if (cursor > stat.size) { cursor = 0; reset = true; }
  if (cursor === stat.size) return { consumed: 0, cursor, reset };
  const handle = fs.openSync(legacyConfig.changeOutboxFile, "r");
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(stat.size - cursor);
    fs.readSync(handle, chunk, 0, chunk.length, cursor);
  } finally { fs.closeSync(handle); }
  const raw = chunk.toString("utf8");
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline < 0) return { consumed: 0, cursor, reset };
  const complete = raw.slice(0, lastNewline + 1);
  const lines = complete.split("\n").filter(Boolean);
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT OR IGNORE INTO change_outbox(
    event_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, source_system, occurred_at, committed_at
  ) VALUES(?, ?, ?, ?, ?, ?, 'v1', ?, ?)`);
  let consumed = 0;
  let lastEventId = "";
  (await db.transaction(async () => {
    for (const line of lines) {
      try {
        const event = object(JSON.parse(line));
        const payload = object(event.payload);
        const sanitized = {
          sourceRevision: String(payload.sourceRevision || ""),
          changedIds: Array.isArray(payload.changedIds) ? payload.changedIds.map(String).slice(0, 5000) : [],
          deletedIds: Array.isArray(payload.deletedIds) ? payload.deletedIds.map(String).slice(0, 5000) : [],
          count: Number(payload.count || 0),
        };
        lastEventId = String(event.eventId || "");
        if (!lastEventId) continue;
        const result = (await insert.run(lastEventId, String(event.aggregateType || "mapping_collection"),
          String(event.aggregateId || "access-config"), Number(event.aggregateVersion || 1),
          String(event.eventType || "mapping_collection_changed"), JSON.stringify(sanitized),
          String(event.occurredAt || now), now));
        consumed += result.changes;
      } catch {
        // A malformed line is skipped only after it is durably delimited. File
        // signature reconciliation still imports the authoritative snapshot.
      }
    }
    cursor += Buffer.byteLength(complete);
    (await db.prepare(`INSERT INTO sync_consumers(consumer, last_sequence, last_event_id, source_cursor, updated_at)
      VALUES('v2-from-v1-outbox', 0, ?, ?, ?)
      ON CONFLICT(consumer) DO UPDATE SET last_event_id=excluded.last_event_id,
        source_cursor=excluded.source_cursor, updated_at=excluded.updated_at`).run(lastEventId, String(cursor), now));
  })());
  return { consumed, cursor, reset };
}
