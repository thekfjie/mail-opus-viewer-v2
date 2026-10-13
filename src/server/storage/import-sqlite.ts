import SQLite from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { MySqlDatabase } from './mysql.js';
import { importTables } from './schema-v1.js';

const quote = (value: string) => '`' + value.replaceAll('`','``') + '`';
function canonicalRow(row: any, columns: string[]) {
  return JSON.stringify(columns.map(c => row[c] ?? null)) + '\n';
}

/** Import a quiescent, backed-up v29 database. Never changes the SQLite source. */
export async function importSqlite(sourcePath: string, destination: MySqlDatabase) {
  const source = new SQLite(sourcePath, { readonly: true, fileMustExist: true });
  try {
    if ((source.pragma('integrity_check') as any[]).some(r => r.integrity_check !== 'ok') || (source.pragma('foreign_key_check') as any[]).length) throw new Error('Source SQLite integrity check failed');
    const version = (source.prepare('SELECT MAX(version) version FROM schema_meta').get() as any)?.version;
    if (Number(version) !== 29) throw new Error('Source must be upgraded to SQLite schema v29 before import');
    const destinationVersion = await destination.prepare('SELECT MAX(version) version FROM opus_schema_versions').get();
    if (Number(destinationVersion?.version) !== 1) throw new Error('Run db:migrate before import');
    const sourceTables = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map(r=>r.name));
    const knownTables = new Set(importTables.map(t=>t.name));
    if ([...sourceTables].some(t => !knownTables.has(t))) throw new Error('Source has unknown tables; refusing an incomplete migration');
    const result: Array<{ table: string; rows: number; sha256: string }> = [];
    // A single InnoDB transaction makes the entire import rollback on failure.
    // Application/worker must remain stopped until validation has committed.
    await destination.transaction(async () => {
      for (const table of importTables) {
        const count = await destination.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`).get();
        if (Number(count.n) && !(table.name === 'mail_read_control' && Number(count.n) === 1)) throw new Error('Destination must be empty');
      }
      // FK dependency ordering: every referenced table precedes its dependent.
      const pending = [...importTables]; const done = new Set<string>();
      while (pending.length) {
        const index = pending.findIndex(t => (source.pragma(`foreign_key_list(${quote(t.name)})`) as any[]).every(f => f.table===t.name || done.has(f.table)));
        if (index < 0) throw new Error('Cyclic source foreign keys require a reviewed migration');
        const table = pending.splice(index,1)[0]; const columns = table.columns.map(c=>c.name);
        const actual = (source.pragma(`table_info(${quote(table.name)})`) as any[]).map(c=>c.name);
        if (actual.length !== columns.length || columns.some(c=>!actual.includes(c))) throw new Error(`Source schema mismatch: ${table.name}`);
        if (table.name === 'mail_read_control') await destination.prepare('DELETE FROM mail_read_control').run();
        const insert = destination.prepare(`INSERT INTO ${quote(table.name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
        let count=0; const checksum=crypto.createHash('sha256');
        const orderedColumns = table.columns.filter(c=>c.pk).map(c=>c.name);
        const order = (orderedColumns.length ? orderedColumns : columns).map(quote).join(',');
        for (const row of source.prepare(`SELECT * FROM ${quote(table.name)} ORDER BY ${order}`).iterate() as Iterable<any>) {
          for (const c of table.columns) {
            const limit=/VARCHAR\((\d+)\)/.exec(c.mysqlType);
            if (limit && row[c.name] != null && [...String(row[c.name])].length > Number(limit[1])) throw new Error(`Value exceeds MySQL column limit: ${table.name}.${c.name}`);
          }
          await insert.run(...columns.map(c=>row[c])); checksum.update(canonicalRow(row,columns));count++;
        }
        const actualSum=crypto.createHash("sha256"); let actualCount=0;
        // Bounded pages; import runs without concurrent writers.
        for(let offset=0;offset<count;offset+=500) {
          const rows=await destination.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table.name)} ORDER BY ${order} LIMIT 500 OFFSET ?`).all(offset);
          for(const row of rows){actualSum.update(canonicalRow(row,columns));actualCount++;}
        }
        const expectedHash=checksum.digest("hex"), actualHash=actualSum.digest("hex");
        if(count!==actualCount || expectedHash!==actualHash)throw new Error(`Import verification failed: ${table.name}`);
        result.push({table:table.name,rows:count,sha256:expectedHash});done.add(table.name);
      }
    })();
    return result;
  } finally { source.close(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const source=process.argv[2];const report=process.argv[3];
  if(!source||!report||!config.mysqlUrl)throw new Error('Usage: npm run db:import-sqlite -- backup.sqlite report.json (MYSQL_URL required)');
  const db=new MySqlDatabase(config.mysqlUrl);
  try { const tables=await importSqlite(source,db);fs.writeFileSync(report,JSON.stringify({completedAt:new Date().toISOString(),tables},null,2),{mode:0o600});console.log(`Imported and verified ${tables.length} tables`); }
  catch(error){console.error((error as Error).message);process.exitCode=1;}
  finally{await db.close();}
}
