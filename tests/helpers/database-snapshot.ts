import type { Database } from '../../src/server/storage/types.js';
import { importTables } from '../../src/server/storage/schema-v1.js';
/** Portable read-only fixture inspection, never used by the public API. */
export async function databaseSnapshot(db: Database): Promise<string> {
  const result = [];
  for (const table of importTables) {
    const rows = await db.prepare(`SELECT ${table.columns.map(c=>'`'+c.name+'`').join(',')} FROM \`${table.name}\``).all();
    result.push([table.name, rows.map(row=>JSON.stringify(row)).sort()]);
  }
  return JSON.stringify(result);
}
