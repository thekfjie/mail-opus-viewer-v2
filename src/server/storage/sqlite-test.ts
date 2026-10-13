// SQLite is retained ONLY for migration preparation and offline regression tests.
import SQLite from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database, Statement } from './types.js';
export class SqliteTestDatabase implements Database {
  readonly dialect = 'sqlite' as const;
  private context = new AsyncLocalStorage<boolean>();
  private tail: Promise<unknown> = Promise.resolve();
  private savepoint = 0;
  readonly raw: SQLite.Database;
  constructor(input: SQLite.Database | string | Buffer, options?: SQLite.Options) {
    this.raw = typeof input === 'string' || Buffer.isBuffer(input) ? new SQLite(input, options) : input;
  }
  serialize() { return this.raw.serialize(); }
  backup(destination: string) { return this.raw.backup(destination); }
  get name() { return this.raw.name; }
  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const next = this.tail.then(() => this.context.run(true, operation));
    this.tail = next.catch(() => {});
    return next;
  }
  prepare(sql: string): Statement {
    return {
      get: (...p) => this.exclusive(() => this.raw.prepare(sql).get(...p)),
      all: (...p) => this.exclusive(() => this.raw.prepare(sql).all(...p) as any[]),
      run: (...p) => this.exclusive(() => this.raw.prepare(sql).run(...p)),
    };
  }
  exec(sql: string) { return this.exclusive(() => { this.raw.exec(sql); }); }
  pragma(sql: string, options?: SQLite.PragmaOptions) { return this.raw.pragma(sql, options); }
  transaction<T extends (...args: any[]) => any>(task: T) {
    const run = (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => this.exclusive(async () => {
      const name = `nested_${++this.savepoint}`;
      const nested = this.raw.inTransaction;
      this.raw.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
      try {
        const result = await task(...args);
        this.raw.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
        return result;
      } catch (error) {
        this.raw.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK');
        if (nested) this.raw.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    });
    return Object.assign(run, { immediate: run });
  }
  async close() { await this.exclusive(() => this.raw.close()); }
  async health() {
    return { integrity: String((await this.prepare('PRAGMA integrity_check').get()).integrity_check),
      foreignKeyViolations: (await this.prepare('PRAGMA foreign_key_check').all()).length };
  }
}
