/** Admission control only: database transactions remain responsible for durable correctness. */
export type TaskMutexResult<T> = { acquired: true; value: T } | { acquired: false };

export interface TaskMutex {
  /** Busy calls skip immediately. A completed result must never be cached or replayed. */
  runExclusive<T>(key: string, task: () => T | Promise<T>): Promise<TaskMutexResult<T>>;
}

/** One process, one shared instance. No lease expiry, timers, persistence or external connections. */
export class InProcessTaskMutex implements TaskMutex {
  private readonly running = new Set<string>();

  async runExclusive<T>(key: string, task: () => T | Promise<T>): Promise<TaskMutexResult<T>> {
    if (this.running.has(key)) return { acquired: false };
    this.running.add(key);
    try {
      return { acquired: true, value: await task() };
    } finally {
      this.running.delete(key);
    }
  }
}
