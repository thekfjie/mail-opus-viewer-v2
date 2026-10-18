import { config } from '../config.js';
import { MySqlDatabase } from './mysql.js';
import { tables, foreignKeys } from './schema-v1.js';
import { pathToFileURL } from 'node:url';

export async function migrateMySql(database: MySqlDatabase): Promise<void> {
  // The lock and every migration statement share one session. Borrowing from
  // the pool again while holding this connection deadlocks a one-slot pool.
  const connection = await database.pool.getConnection();
  let locked = false;
  try {
    const [lock] = await connection.query<any[]>("SELECT GET_LOCK(CONCAT(DATABASE(), ':schema'),30) AS acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('Schema migration is already running');
    locked = true;
    await connection.query('CREATE TABLE IF NOT EXISTS opus_schema_versions(version INT PRIMARY KEY, applied_at VARCHAR(40) NOT NULL) ENGINE=InnoDB');
    const [versions] = await connection.query<any[]>('SELECT MAX(version) AS version FROM opus_schema_versions');
    const current = versions[0];
    if (Number(current?.version) > 1) throw new Error('Database schema is newer than this application');
    if (Number(current?.version) === 1) return;
    for (const sql of tables) await connection.query(sql);
    for (const fk of foreignKeys) {
      const [existing] = await connection.execute<any[]>('SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name=? AND constraint_name=?', [fk.table, fk.name]);
      if (!existing.length) await connection.query(fk.sql);
    }
    await connection.query('INSERT INTO mail_read_control(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id');
    await connection.execute('INSERT INTO opus_schema_versions(version, applied_at) VALUES(1,?)', [new Date().toISOString()]);
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':schema'))").catch(() => {});
    connection.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!config.mysqlUrl) throw new Error('MYSQL_URL is required');
  const db = new MySqlDatabase(config.mysqlUrl);
  try { await migrateMySql(db); console.log('MySQL schema is ready (version 1)'); }
  catch (error) { console.error('MySQL migration failed:', (error as any).code || (error as Error).message); process.exitCode = 1; }
  finally { await db.close(); }
}
