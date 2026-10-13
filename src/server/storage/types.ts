export interface RunResult { changes: number; lastInsertRowid: number | bigint }
export interface Statement {
  get(...parameters: any[]): Promise<any>;
  all(...parameters: any[]): Promise<any[]>;
  run(...parameters: any[]): Promise<RunResult>;
}
export interface Database {
  readonly dialect: 'mysql' | 'sqlite';
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  transaction<T extends (...args: any[]) => any>(task: T): ((...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>) & {
    immediate(...args: Parameters<T>): Promise<Awaited<ReturnType<T>>>;
  };
  close(): Promise<void>;
  health(): Promise<{ integrity: string; foreignKeyViolations: number | null }>;
}
