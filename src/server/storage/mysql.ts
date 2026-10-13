import { AsyncLocalStorage } from 'node:async_hooks';
import mysql, { type PoolConnection, type ResultSetHeader } from 'mysql2/promise';
import type { Database, Statement } from './types.js';
import { mysqlSql } from './mysql-sql.js';

export class MySqlDatabase implements Database {
  readonly dialect = 'mysql' as const;
  private context = new AsyncLocalStorage<PoolConnection>();
  private savepoint = 0;
  readonly pool;
  constructor(url: string, poolSize = 10) {
    this.pool = mysql.createPool({ uri: url, connectionLimit: poolSize, waitForConnections: true,
      queueLimit: 100, connectTimeout: 5000, charset: 'utf8mb4_bin', timezone: 'Z',
      supportBigNumbers: true, decimalNumbers: true, dateStrings: true, flags: ['-FOUND_ROWS'],
      jsonStrings: true, multipleStatements: false });
    this.pool.on('connection', (connection) => {
      connection.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,PIPES_AS_CONCAT,NO_BACKSLASH_ESCAPES', time_zone='+00:00', group_concat_max_len=1048576");
    });
  }
  private async query(sql: string, parameters: any[] = []): Promise<any> {
    try {
      const connection = this.context.getStore() ?? this.pool;
      const translated = mysqlSql(sql);
      // Prepared parameters are essential with NO_BACKSLASH_ESCAPES: inline SQL
      // keeps SQLite's literal-backslash semantics; user values stay protocol data.
      const [rows] = parameters.length
        ? await connection.execute(translated, parameters.map(v => v === undefined ? null : v))
        : await connection.query(translated);
      return rows;
    } catch (cause) {
      // mysql2 errors contain the interpolated SQL. Never let those escape to API/logs.
      const error = new Error(`Database operation failed (${String((cause as any)?.code || 'UNKNOWN')})`);
      Object.assign(error, { code: String((cause as any)?.code || 'UNKNOWN') });
      throw error;
    }
  }
  prepare(sql: string): Statement {
    return {
      get: async (...p) => (await this.query(sql, p))[0],
      all: async (...p) => this.query(sql, p),
      run: async (...p) => { const r = await this.query(sql, p) as ResultSetHeader;
        const matched = /^UPDATE\b/i.test(sql.trim()) ? /Rows matched:\s*(\d+)/i.exec(r.info || '') : null;
        return { changes: matched ? Number(matched[1]) : r.affectedRows, lastInsertRowid: r.insertId }; },
    };
  }
  async exec(sql: string) { await this.query(sql); }
  transaction<T extends (...args: any[]) => any>(task: T) {
    const run = async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
      const inherited = this.context.getStore();
      const connection = inherited ?? await this.pool.getConnection();
      const name = `nested_${++this.savepoint}`;
      try {
        if (inherited) await connection.query(`SAVEPOINT ${name}`);
        else {
          await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          await connection.beginTransaction();
        }
        const result = await this.context.run(connection, () => task(...args));
        if (inherited) await connection.query(`RELEASE SAVEPOINT ${name}`);
        else await connection.commit();
        return result;
      } catch (cause) {
        try { if (inherited) await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); else await connection.rollback(); } catch {}
        // Domain errors are already safe; raw driver failures must be redacted.
        if ((cause as any)?.sql) throw Object.assign(new Error('Database transaction failed'), { code: (cause as any).code });
        throw cause;
      } finally { if (!inherited) connection.release(); }
    };
    return Object.assign(run, { immediate: run });
  }
  async health() { await this.prepare('SELECT 1 AS ok').get(); return { integrity: 'reachable', foreignKeyViolations: null }; }
  async close() { await this.pool.end(); }
}
