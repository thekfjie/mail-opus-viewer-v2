import { config } from './config.js';
import type { Database } from './storage/types.js';
import { MySqlDatabase } from './storage/mysql.js';

async function connect(): Promise<Database> {
  if (process.env.OPUS_SQLITE_TEST === '1') {
    if (process.env.NODE_ENV === 'production') throw new Error('SQLite test backend is forbidden in production');
    return (await import('./storage/legacy-sqlite-bootstrap.js')).openLegacySqlite();
  }
  if (!config.mysqlUrl) throw new Error('MYSQL_URL is required. Run npm run db:migrate before starting the service.');
  const database = new MySqlDatabase(config.mysqlUrl, config.mysqlPoolSize);
  try {
    const row = await database.prepare('SELECT version FROM opus_schema_versions ORDER BY version DESC LIMIT 1').get();
    if (Number(row?.version) !== 1) throw new Error('Unsupported MySQL schema; run npm run db:migrate');
    return database;
  } catch { await database.close(); throw new Error('MySQL is unavailable or schema is not ready; run npm run db:migrate'); }
}
export const db = await connect();
