import crypto from "node:crypto";
import type { Database } from "better-sqlite3";

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

export const MAIL_READ_LIMITS = Object.freeze({
  // Keep conservative offline defaults; production raises these through the
  // protected runtime environment after capacity review.
  perMinute: boundedEnvInt("V2_MAIL_READ_PER_MINUTE", 60, 60, 5_000),
  perDay: boundedEnvInt("V2_MAIL_READ_PER_DAY", 1_000, 1_000, 100_000),
  attempts: 2, timeoutMs: 15_000,
  backfillPage: 100, backfillWindowMs: 86_400_000, backfillCooldownMs: 600_000,
  failureCooldownMs: 60_000, maxRowsRead: 10_000, maxRowsReadPerDay: 100_000,
});

export class MailReadError extends Error {
  constructor(public readonly code: string, public readonly status = 503) {
    super(code);
    this.name = "MailReadError";
  }
}

export function applyMailIngestionSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mail_read_requests (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, rows_read INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_mail_read_started ON mail_read_requests(started_at);
    CREATE TABLE IF NOT EXISTS mail_read_control (
      id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL DEFAULT '',
      lease_until INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT NOT NULL DEFAULT '',
      backfill_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO mail_read_control(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS mail_read_failures (
      request_key TEXT PRIMARY KEY, retry_after INTEGER NOT NULL, error_code TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_ingestion_state (
      provider TEXT NOT NULL, provider_message_id TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '', discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(provider, provider_message_id)
    );
    CREATE TABLE IF NOT EXISTS mail_ingestion_leases (
      provider TEXT NOT NULL, provider_message_id TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
      retry_after INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(provider, provider_message_id),
      FOREIGN KEY(provider, provider_message_id)
        REFERENCES mail_ingestion_state(provider, provider_message_id) ON DELETE CASCADE
    );
  `);
}

export interface SharedMailRow {
  id: string | number;
  source?: string;
  address?: string;
  raw?: string;
  raw_blob?: number[] | string | null;
  created_at?: string;
  subject?: string;
  text?: string;
  html?: string;
  from?: string;
  to?: string;
}

export interface BackfillCursor { createdAt: string; id: string }
export interface BackfillWindow { from: string; to: string; cursor?: BackfillCursor }
export interface D1MailOptions {
  accountId: string;
  databaseId: string;
  readToken: string;
  timeIndex?: string;
  transport?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  leaseWaitMs?: number;
}

function positiveId(value: unknown): string {
  const id = String(value ?? "");
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new MailReadError("invalid_mail_id", 400);
  return id;
}

function d1Date(value: string): string {
  const timestamp = d1Timestamp(value);
  if (!Number.isFinite(timestamp)) throw new MailReadError("invalid_mail_window", 400);
  return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", "").replace(/Z$/, "");
}

function d1Timestamp(value: string): number {
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
}

function timeIndexName(value: string | undefined): string {
  const index = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(index)) throw new MailReadError("mail_d1_time_index_unverified");
  return index;
}

function backfillSql(index: string): string {
  return `SELECT id, source, address, raw, raw_blob, created_at FROM raw_mails INDEXED BY "${index}"
    WHERE created_at>=? AND created_at<? AND (created_at,id)>(?,?)
    ORDER BY created_at ASC, id ASC LIMIT 100`;
}

function isPlainTimeIndex(sql: unknown, index: string): boolean {
  if (typeof sql !== "string") return false;
  // Accept only ordinary named columns. Expressions, collations, comments and
  // partial-index predicates deliberately fail closed rather than being parsed
  // as executable SQL or treated as proof of a bounded range lookup.
  const identifier = '(?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*"|`[A-Za-z_][A-Za-z0-9_]*`|\\[[A-Za-z_][A-Za-z0-9_]*\\])';
  const definition = new RegExp(`^\\s*CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})\\s+ON\\s+(${identifier})\\s*\\(([^()]+)\\)\\s*;?\\s*$`, "i").exec(sql);
  const unquote = (value: string) => value.replace(/^["`\[]|["`\]]$/g, "").toLowerCase();
  if (!definition || unquote(definition[1]) !== index.toLowerCase() || unquote(definition[2]) !== "raw_mails") return false;
  const column = new RegExp(`^\\s*(${identifier})(?:\\s+(?:ASC|DESC))?\\s*$`, "i");
  const columns = definition[3].split(",").map((value) => column.exec(value));
  return columns.every(Boolean) && unquote(columns[0]![1]) === "created_at";
}

async function boundedJson(response: Response): Promise<any> {
  const maxBytes = 16 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new MailReadError("mail_d1_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MailReadError("mail_d1_invalid_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new MailReadError("mail_d1_response_too_large");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

export function validateBackfillWindow(window: BackfillWindow): void {
  const from = Date.parse(window?.from);
  const to = Date.parse(window?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > MAIL_READ_LIMITS.backfillWindowMs) {
    throw new MailReadError("invalid_mail_window", 400);
  }
  if (window.cursor) {
    const at = Date.parse(window.cursor.createdAt);
    positiveId(window.cursor.id);
    if (!Number.isFinite(at) || at < from || at >= to) throw new MailReadError("invalid_mail_cursor", 400);
  }
}

export class D1MailReader {
  private readonly pending = new Map<string, Promise<SharedMailRow | null>>();
  private queryTail: Promise<void> = Promise.resolve();
  private queuedQueries = 0;
  private readonly now: () => number;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private readonly leaseWaitMs: number;

  constructor(private readonly database: Database, private readonly options: D1MailOptions) {
    this.now = options.now || Date.now;
    this.transport = options.transport || ((...args) => globalThis.fetch(...args));
    this.timeoutMs = Math.max(1, Math.min(MAIL_READ_LIMITS.timeoutMs, options.timeoutMs || MAIL_READ_LIMITS.timeoutMs));
    this.leaseWaitMs = Math.max(0, Math.min(5_000, Number(options.leaseWaitMs || 0)));
  }

  private configured(): void {
    if (!this.options.accountId || !this.options.databaseId || !this.options.readToken) throw new MailReadError("mail_d1_not_configured");
    if (!/^[a-zA-Z0-9-]+$/.test(this.options.accountId) || !/^[a-zA-Z0-9-]+$/.test(this.options.databaseId)) {
      throw new MailReadError("mail_d1_invalid_configuration");
    }
  }

  private acquire(key: string): string {
    return this.database.transaction(() => {
      const now = this.now();
      const control = this.database.prepare("SELECT * FROM mail_read_control WHERE id=1").get() as any;
      if (!control) throw new MailReadError("mail_schema_not_ready");
      if (control.blocked_reason) throw new MailReadError(String(control.blocked_reason));
      if (control.lease_until > now) throw new MailReadError("mail_read_busy", 429);
      // A process can exit after sending a request but before recording its cost.
      // Keep that reservation and charge the maximum accepted cost on recovery.
      if (control.owner) {
        this.database.prepare(`UPDATE mail_read_requests SET outcome='mail_d1_interrupted', rows_read=?
          WHERE id=? AND outcome='pending'`).run(MAIL_READ_LIMITS.maxRowsRead, control.owner);
      }
      const failure = this.database.prepare("SELECT retry_after FROM mail_read_failures WHERE request_key=?").get(key) as any;
      if (Number(failure?.retry_after) > now) throw new MailReadError("mail_read_cooling_down", 429);
      this.database.prepare("DELETE FROM mail_read_requests WHERE started_at<=?").run(now - 86_400_000);
      this.database.prepare("DELETE FROM mail_read_failures WHERE retry_after<=?").run(now);
      const counts = this.database.prepare(`SELECT COUNT(*) daily,
        COALESCE(SUM(CASE WHEN started_at>? THEN 1 ELSE 0 END),0) minute,
        COALESCE(SUM(rows_read),0) rows_read FROM mail_read_requests`).get(now - 60_000) as any;
      if (counts.daily >= MAIL_READ_LIMITS.perDay || counts.minute >= MAIL_READ_LIMITS.perMinute
        || counts.rows_read >= MAIL_READ_LIMITS.maxRowsReadPerDay) throw new MailReadError("mail_read_budget_exhausted", 429);
      const id = crypto.randomUUID();
      this.database.prepare("UPDATE mail_read_control SET owner=?, lease_until=? WHERE id=1")
        .run(id, now + this.timeoutMs + 5_000);
      this.database.prepare("INSERT INTO mail_read_requests(id, started_at) VALUES(?, ?)").run(id, now);
      return id;
    }).immediate();
  }

  private async acquireWhenAvailable(key: string): Promise<string> {
    const deadline = Date.now() + this.leaseWaitMs;
    for (;;) {
      try {
        return this.acquire(key);
      } catch (error) {
        if (!(error instanceof MailReadError) || error.code !== "mail_read_busy" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async serializeQuery<Row>(task: () => Promise<Row[]>): Promise<Row[]> {
    // The durable lease protects separate processes. Within one server process,
    // queue different message IDs so ordinary concurrent page opens do not race
    // that lease and fail immediately with mail_read_busy.
    if (this.queuedQueries >= 128) throw new MailReadError("mail_read_busy", 429);
    this.queuedQueries += 1;
    const previous = this.queryTail;
    let release!: () => void;
    this.queryTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      this.queuedQueries -= 1;
      release();
    }
  }

  private async query<Row = SharedMailRow>(key: string, sql: string, params: unknown[]): Promise<Row[]> {
    return this.serializeQuery<Row>(async () => {
      this.configured();
      for (let attempt = 0; attempt < MAIL_READ_LIMITS.attempts; attempt += 1) {
        const requestId = await this.acquireWhenAvailable(key);
        let errorCode = "mail_read_failed";
        let retryable = false;
        try {
          const response = await this.transport(
            `https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/d1/database/${this.options.databaseId}/query`,
            { method: "POST", redirect: "error", headers: { authorization: `Bearer ${this.options.readToken}`, "content-type": "application/json" },
              body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(this.timeoutMs) },
          );
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            retryable = response.status >= 500;
            errorCode = response.status === 401 || response.status === 403 ? "mail_d1_unauthorized"
              : response.status === 429 ? "mail_d1_quota_exhausted" : "mail_d1_upstream_failure";
            if ([401, 403, 429].includes(response.status)) {
              this.database.prepare("UPDATE mail_read_control SET blocked_reason=? WHERE id=1").run(errorCode);
            }
            throw new MailReadError(errorCode);
          }
          const payload = await boundedJson(response);
          const result = payload?.result?.[0];
          if (payload?.success !== true || result?.success === false || !Array.isArray(result?.results)) {
            this.database.prepare("UPDATE mail_read_control SET blocked_reason='mail_d1_query_rejected' WHERE id=1").run();
            throw new MailReadError("mail_d1_query_rejected");
          }
          const rowsRead = Number(result?.meta?.rows_read);
          if (!Number.isSafeInteger(rowsRead) || rowsRead < 0) {
            this.database.prepare("UPDATE mail_read_control SET blocked_reason='mail_d1_missing_cost' WHERE id=1").run();
            throw new MailReadError("mail_d1_missing_cost");
          }
          this.database.prepare("UPDATE mail_read_requests SET rows_read=?, outcome='ok' WHERE id=?").run(rowsRead, requestId);
          if (rowsRead > MAIL_READ_LIMITS.maxRowsRead) {
            this.database.prepare("UPDATE mail_read_control SET blocked_reason='mail_d1_query_cost_exceeded' WHERE id=1").run();
            throw new MailReadError("mail_d1_query_cost_exceeded");
          }
          if (result.results.length > MAIL_READ_LIMITS.backfillPage) throw new MailReadError("mail_d1_response_limit_exceeded");
          return result.results as Row[];
        } catch (error) {
          if (error instanceof MailReadError) errorCode = error.code;
          else if (error instanceof Error && ["TimeoutError", "AbortError", "TypeError"].includes(error.name)) {
            errorCode = "mail_d1_transport_failure";
            retryable = true;
          }
          this.database.prepare("UPDATE mail_read_requests SET outcome=? WHERE id=?").run(errorCode, requestId);
          if (!retryable || attempt + 1 >= MAIL_READ_LIMITS.attempts) {
            this.database.prepare(`INSERT INTO mail_read_failures(request_key, retry_after, error_code) VALUES(?, ?, ?)
              ON CONFLICT(request_key) DO UPDATE SET retry_after=excluded.retry_after, error_code=excluded.error_code`)
              .run(key, this.now() + MAIL_READ_LIMITS.failureCooldownMs, errorCode);
            throw new MailReadError(errorCode);
          }
        } finally {
          this.database.prepare("UPDATE mail_read_control SET owner='', lease_until=0 WHERE id=1 AND owner=?").run(requestId);
        }
      }
      throw new MailReadError("mail_read_failed");
    });
  }

  byId(input: string): Promise<SharedMailRow | null> {
    const id = positiveId(input);
    const existing = this.pending.get(id);
    if (existing) return existing;
    const task = this.query(`id:${id}`, "SELECT id, source, address, raw, raw_blob, created_at FROM raw_mails WHERE id=? LIMIT 1", [id])
      .then((rows) => {
        if (!rows.length) return null;
        if (rows.length !== 1 || String(rows[0]?.id) !== id) throw new MailReadError("mail_d1_message_mismatch");
        return rows[0];
      }).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  async verifyTimeIndex(): Promise<{ verified: true }> {
    const index = timeIndexName(this.options.timeIndex);
    const rows = await this.query<{ sql?: unknown }>(`index:${index}`,
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='raw_mails' AND name=? LIMIT 1", [index]);
    if (rows.length !== 1 || !isPlainTimeIndex(rows[0]?.sql, index)) throw new MailReadError("mail_d1_time_index_unverified");
    // EXPLAIN prepares the exact bounded query used below without reading mail
    // rows. INDEXED BY alone only proves that an index exists; it does not prove
    // that SQLite can SEARCH it instead of scanning or sorting the full range.
    const plan = await this.query<{ detail?: unknown }>(`index-plan:${index}`, `EXPLAIN QUERY PLAN ${backfillSql(index)}`,
      ["1970-01-01 00:00:00", "1970-01-02 00:00:00", "1970-01-01 00:00:00", 0]);
    const search = new RegExp(`^SEARCH raw_mails USING (?:COVERING )?INDEX ${index} \\(created_at[><=]`, "i");
    if (plan.length !== 1 || typeof plan[0]?.detail !== "string" || !search.test(plan[0].detail)
      || /\bSCAN\b|TEMP B-TREE/i.test(plan[0].detail)) throw new MailReadError("mail_d1_time_index_plan_unverified");
    return { verified: true };
  }

  async backfill(window: BackfillWindow): Promise<{ rows: SharedMailRow[]; complete: boolean; cursor: BackfillCursor | null }> {
    this.configured();
    validateBackfillWindow(window);
    const index = timeIndexName(this.options.timeIndex);
    this.database.transaction(() => {
      const row = this.database.prepare("SELECT backfill_at FROM mail_read_control WHERE id=1").get() as any;
      if (row?.backfill_at && this.now() - row.backfill_at < MAIL_READ_LIMITS.backfillCooldownMs) {
        throw new MailReadError("mail_backfill_cooling_down", 429);
      }
      this.database.prepare("UPDATE mail_read_control SET backfill_at=? WHERE id=1").run(this.now());
    }).immediate();
    const from = d1Date(window.from);
    const to = d1Date(window.to);
    const cursorAt = window.cursor ? d1Date(window.cursor.createdAt) : from;
    const cursorId = window.cursor?.id || "0";
    // INDEXED BY fails closed when the independently verified time index is absent.
    const rows = await this.query(`backfill:${from}:${to}:${cursorAt}:${cursorId}`,
      backfillSql(index), [from, to, cursorAt, Number(cursorId)]);
    let previousAt = Date.parse(window.cursor?.createdAt || window.from);
    let previousId = Number(cursorId);
    for (const row of rows) {
      const id = Number(positiveId(row.id));
      const at = d1Timestamp(String(row.created_at || ""));
      if (!Number.isFinite(at) || at < Date.parse(window.from) || at >= Date.parse(window.to)
        || at < previousAt || (at === previousAt && id <= previousId)) throw new MailReadError("mail_d1_invalid_cursor_order");
      previousAt = at;
      previousId = id;
    }
    const last = rows.at(-1);
    return { rows, complete: rows.length < MAIL_READ_LIMITS.backfillPage,
      cursor: last ? { createdAt: new Date(previousAt).toISOString(), id: String(last.id) } : window.cursor || null };
  }
}
