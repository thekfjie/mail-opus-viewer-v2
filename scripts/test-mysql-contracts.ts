import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MySqlDatabase } from '../src/server/storage/mysql.js';
import { migrateMySql } from '../src/server/storage/migrate.js';

if (!process.env.MYSQL_URL || !process.env.REDIS_URL) throw new Error('MYSQL_URL and REDIS_URL are required');
if (process.env.OPUS_SQLITE_TEST === '1') throw new Error('Do not use the SQLite test flag for MySQL contracts');
const tests = process.argv.slice(2);
const files = tests.length ? tests : [
  'account-order', 'business-regressions', 'multigeneration-identity', 'rebind-order',
  'mail-ingestion', 'mail-ingestion-reliability', 'mail-metadata-event', 'mail-health', 'runtime-api',
  'compatibility-review', 'payment-eligibility-api', 'mail-security', 'plus-plan-state',
  'payment-exposure', 'payment-exposure-batch', 'recycle-eligibility', 'customer-ban-access',
  'pending-credential-visibility', 'third-party-file-import', 'sub2api-sync', 'auto-trial',
];
const admin = new MySqlDatabase(process.env.MYSQL_URL);
let failed = 0;
try {
  for (const file of files) {
    const name = 'opus_contract_' + crypto.randomBytes(6).toString('hex');
    const url = new URL(process.env.MYSQL_URL); url.pathname = '/' + name;
    await admin.exec(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    const db = new MySqlDatabase(url.href);
    try {
      await migrateMySql(db); await db.close();
      const code = await new Promise<number>(resolve => {
        const child = spawn(process.execPath, ['--import','tsx','--test',`tests/${file}.test.ts`], {
          stdio: 'inherit', env: {...process.env, MYSQL_URL:url.href, ENV_FILE:'/dev/null'},
        });
        child.on('error',()=>resolve(1));child.on('close',code=>resolve(code ?? 1));
      });
      if (code) failed++;
    } finally { await db.close().catch(()=>{}); await admin.exec(`DROP DATABASE \`${name}\``); }
  }
} finally { await admin.close(); }
console.log(JSON.stringify({ suites:files.length, failed, backend:'mysql' }));
process.exitCode = failed ? 1 : 0;
