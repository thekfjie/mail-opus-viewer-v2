import { config } from '../config.js';
import { MySqlDatabase } from './mysql.js';
import { tables, foreignKeys } from './schema-v1.js';
import { pathToFileURL } from 'node:url';

export async function migrateMySql(database: MySqlDatabase): Promise<void> {
  // A dedicated session owns the migration lock, independent of pool borrowing.
  const connection = await database.pool.getConnection();
  let locked = false;
  try {
    const [lock] = await connection.query<any[]>("SELECT GET_LOCK(CONCAT(DATABASE(), ':schema'),30) AS acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('Schema migration is already running');
    locked = true;
    await database.exec('CREATE TABLE IF NOT EXISTS opus_schema_versions(version INT PRIMARY KEY, applied_at VARCHAR(40) NOT NULL) ENGINE=InnoDB');
    const current = await database.prepare('SELECT MAX(version) AS version FROM opus_schema_versions').get();
    if (Number(current?.version) > 1) throw new Error('Database schema is newer than this application');
    if (Number(current?.version) === 1) return;
    for (const sql of tables) await database.exec(sql);
    for (const fk of foreignKeys) {
      const exists = await database.prepare('SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name=? AND constraint_name=?').get(fk.table, fk.name);
      if (!exists) await database.exec(fk.sql);
    }
    await database.prepare('INSERT OR IGNORE INTO mail_read_control(id) VALUES(1)').run();
    await database.prepare('INSERT INTO opus_schema_versions(version, applied_at) VALUES(1,?)').run(new Date().toISOString());
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
