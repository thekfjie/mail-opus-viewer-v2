/** Sequential traversal preserves transaction order and bounds external work. */
export async function asyncMap<T, R>(values: readonly T[], fn: (value: T, index: number, values: readonly T[]) => R | Promise<R>): Promise<R[]> {
  const result: R[] = []; for (let i = 0; i < values.length; i++) result.push(await fn(values[i], i, values)); return result;
}
export async function asyncFilter<T>(values: readonly T[], fn: (value: T, index: number) => unknown): Promise<T[]> {
  const result: T[] = []; for (let i = 0; i < values.length; i++) if (await fn(values[i], i)) result.push(values[i]); return result;
}
export async function asyncForEach<T>(values: readonly T[], fn: (value: T, index: number) => unknown): Promise<void> {
  for (let i = 0; i < values.length; i++) await fn(values[i], i);
}
export async function asyncSome<T>(values: readonly T[], fn: (value: T, index: number) => unknown): Promise<boolean> {
  for (let i = 0; i < values.length; i++) if (await fn(values[i], i)) return true; return false;
}
export async function asyncFind<T>(values: readonly T[], fn: (value: T, index: number) => unknown): Promise<T | undefined> {
  for (let i = 0; i < values.length; i++) if (await fn(values[i], i)) return values[i]; return undefined;
}
export async function asyncFlatMap<T, R>(values: readonly T[], fn: (value: T, index: number) => R[] | Promise<R[]>): Promise<R[]> {
  return (await asyncMap(values, fn)).flat();
}
