import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

// A distinct, disposable database is required; never clear the configured database.
test('MySQL migration, transactions, business API and Redis sharing', { timeout: 120_000 }, async t => {
  assert.ok(process.env.MYSQL_URL && process.env.REDIS_URL, 'Real MYSQL_URL and REDIS_URL are required');
  assert.notEqual(process.env.OPUS_SQLITE_TEST, '1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-mysql-'));
  const name = 'opus_test_' + crypto.randomBytes(6).toString('hex');
  const url = new URL(process.env.MYSQL_URL!);
  const { MySqlDatabase } = await import('../../src/server/storage/mysql.js');
  const admin = new MySqlDatabase(url.href);
  await admin.exec(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  url.pathname = '/' + name;
  Object.assign(process.env, { MYSQL_URL: url.href, ENV_FILE: '/dev/null', DATABASE_PATH: path.join(root,'legacy.sqlite'),
    V2_SESSION_SECRET: 'fake-integration-session', CREDENTIAL_ENCRYPTION_KEY: 'fake-integration-key',
    VIEWER_ADMIN_PASSWORD: 'fake-integration-admin', PUBLIC_ORIGIN: 'https://mail.example.test',
    IMPORT_API_KEY: 'fake-import', V2_READ_ONLY: 'false', V2_AUTO_TRIAL_ENABLED: 'false' });
  const database = new MySqlDatabase(url.href);
  t.after(async () => { await database.close(); await admin.exec(`DROP DATABASE \`${name}\``); await admin.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const { migrateMySql } = await import('../../src/server/storage/migrate.js');
  const { importSqlite } = await import('../../src/server/storage/import-sqlite.js');
  const { encryptSecret } = await import('../../src/server/crypto.js');
  const ciphertext = encryptSecret('fake-import-secret');
  await t.test('idempotent schema and verified import preserve encrypted data', async () => {
    await migrateMySql(database); await migrateMySql(database);
    const { openLegacySqlite } = await import('../../src/server/storage/legacy-sqlite-bootstrap.js');
    const source = await openLegacySqlite();
    await source.prepare('INSERT INTO gpt_accounts(id,arrived_at,created_at,updated_at,note) VALUES(?,?,?,?,?)')
      .run('legacy', '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z', ciphertext);
    for (let i=0;i<502;i++) await source.prepare('INSERT INTO gpt_accounts(id,arrived_at,created_at,updated_at,note) VALUES(?,?,?,?,?)')
      .run('page-'+i,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',ciphertext);
    await source.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run('x'.repeat(300),'bad','2026-01-01');
    await source.close();
    await assert.rejects(importSqlite(path.join(root,'legacy.sqlite'),database), /column limit/);
    assert.equal((await database.prepare('SELECT COUNT(*) n FROM gpt_accounts').get()).n,0,'failed import rolled back earlier tables');
    const { default: SQLite } = await import('better-sqlite3');
    const repair = new SQLite(path.join(root,'legacy.sqlite'));
    repair.prepare('DELETE FROM settings WHERE key=?').run('x'.repeat(300)); repair.close();
    const before = fs.readFileSync(path.join(root,'legacy.sqlite'));
    const report = await importSqlite(path.join(root,'legacy.sqlite'),database);
    assert.equal(report.length,51);
    assert.equal(report.find(r=>r.table==='gpt_accounts')?.rows,503);
    assert.equal((await database.prepare('SELECT note FROM gpt_accounts WHERE id=?').get('legacy')).note,ciphertext);
    assert.deepEqual(fs.readFileSync(path.join(root,'legacy.sqlite')),before);
    await assert.rejects(importSqlite(path.join(root,'legacy.sqlite'),database), /empty/);
  });
  await t.test('nested failures roll back and SQL errors never disclose bound values', async () => {
    await database.transaction(async () => {
      await database.prepare("UPDATE gpt_accounts SET note='outer' WHERE id='legacy'").run();
      await assert.rejects(database.transaction(async () => {
        await database.prepare("UPDATE gpt_accounts SET note='inner' WHERE id='legacy'").run();
        throw new Error('rollback');
      })(),/rollback/);
      assert.equal((await database.prepare("SELECT note FROM gpt_accounts WHERE id='legacy'").get()).note,'outer');
    })();
    await assert.rejects(database.transaction(async () => {
      await database.prepare("UPDATE gpt_accounts SET note='lost' WHERE id='legacy'").run();
      throw new Error('rollback');
    })(),/rollback/);
    assert.equal((await database.prepare("SELECT note FROM gpt_accounts WHERE id='legacy'").get()).note,'outer');
    const literal = "quoted ' value \\ path 中文 😀";
    await database.prepare("UPDATE gpt_accounts SET note=? WHERE id='legacy'").run(literal);
    assert.equal((await database.prepare("SELECT note FROM gpt_accounts WHERE id='legacy'").get()).note,literal);
    assert.equal((await database.prepare("UPDATE gpt_accounts SET note=? WHERE id='legacy'").run(literal)).changes,1,'unchanged updates preserve SQLite matched-row semantics');
    await assert.rejects(database.prepare('INSERT INTO gpt_accounts(id) VALUES(?)').run('fake-secret-canary'), e => !String(e).includes('fake-secret-canary'));
  });
  await t.test('concurrent transactions preserve every committed update',async()=>{
    await Promise.all(Array.from({length:20},()=>database.transaction(async()=>{
      await database.prepare("UPDATE gpt_accounts SET group_boundary=group_boundary+1 WHERE id='legacy'").run();
    })()));
    assert.equal((await database.prepare("SELECT group_boundary FROM gpt_accounts WHERE id='legacy'").get()).group_boundary,20);
  });
  const { db } = await import('../../src/server/db.js');
  t.after(async()=>{await db.close();});
  const repo = await import('../../src/server/repository.js');
  await t.test('account import, listing, credential reveal, rebind and revoke on MySQL', async () => {
    const imported = await repo.importAccounts([{email:'mysql@icloud.com',accessToken:'fake-access',refreshToken:'fake-refresh'}]);
    assert.equal(imported.errors.length,0,JSON.stringify(imported));
    const list = await repo.listAccounts({} as any);
    const account = list.results.find(a=>a.primaryEmail==='mysql@icloud.com');
    assert.ok(account,JSON.stringify(list));
    assert.equal((await repo.revealCredentials(account.id))?.accessToken,'fake-access');
    await repo.saveAccountCredentials(account.id,{accessToken:'fake-new-access',refreshToken:'fake-new-refresh'});
    assert.equal((await repo.revealCredentials(account.id))?.accessToken,'fake-new-access');
    await repo.overview(); await repo.getAccountDetail(account.id);
    await repo.createRebind(account.id,'mysql@example.com');
    assert.equal(await repo.primaryEmailForAccount(account.id),'mysql@example.com');
    const binding = await db.prepare('SELECT id FROM email_bindings WHERE account_id=? AND is_current=1').get(account.id);
    const row = await db.prepare('SELECT * FROM email_bindings WHERE id=?').get(binding.id);
    const { importTables } = await import('../../src/server/storage/schema-v1.js');
    const cols = importTables.find(table=>table.name==='email_bindings')!.columns.map(c=>c.name);
    const insert = `INSERT INTO email_bindings(${cols.map(c=>'`'+c+'`').join(',')}) VALUES(${cols.map(()=>'?').join(',')})`;
    await assert.rejects(db.prepare(insert+' ON CONFLICT(id) DO UPDATE SET email_enc=excluded.email_enc')
      .run(...cols.map(c=>c==='id'?'colliding-id':row[c])), /Database operation failed/);
    assert.equal((await db.prepare('SELECT id FROM email_bindings WHERE account_id=? AND is_current=1').get(account.id)).id,binding.id);
    await assert.rejects(db.prepare(insert.replace('INSERT INTO','INSERT OR IGNORE INTO')).run(...cols.map(c=>
      c==='id'?'invalid-fk':c==='account_id'?'nonexistent-account':c==='email_hash'?'unowned-email':c==='legacy_mapping_id'?'new-legacy-id':row[c])), /Database operation failed/);
    const grant = await repo.createCustomerGrant(account.id,binding.id,{password:'fake-customer'});
    assert.ok(await repo.authenticateCustomer('mysql@example.com','fake-customer'));
    await repo.revokeCustomerGrant(account.id,grant.grantId);
    assert.equal(await repo.authenticateCustomer('mysql@example.com','fake-customer'),null);
  });
  await t.test('HTTP readiness and authenticated access work with both real dependencies', async () => {
    const { buildApp } = await import('../../src/server/server.js');
    const app = await buildApp();
    try {
      assert.equal((await app.inject('/ready')).statusCode,200);
      assert.equal((await app.inject('/api/admin/mappings')).statusCode,401);
      const login = await app.inject({method:'POST',url:'/api/admin/login',payload:{password:'fake-integration-admin'}});
      assert.equal(login.statusCode,200,login.body);
      const cookie = login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
      const list = await app.inject({url:'/api/admin/mappings',headers:{cookie}});
      assert.equal(list.statusCode,200,list.body); assert.equal(list.headers['cache-control'],'no-store');
      assert.ok(!list.body.includes('fake-new-access'));
    } finally {await app.close();}
  });
  await t.test('logical backup restores all tables into an isolated database', async () => {
    const { backupMySql } = await import('../../src/server/backup.js');
    const result = await backupMySql(url.href,root);
    const sql = gunzipSync(fs.readFileSync(path.join(root,result.backup)));
    assert.ok(sql.includes(Buffer.from(ciphertext)));
    assert.ok(!sql.includes(Buffer.from('fake-new-access')));
    const restoreName = name+'_restore';
    await admin.exec(`CREATE DATABASE \`${restoreName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    const restoredUrl = new URL(url); restoredUrl.pathname='/'+restoreName;
    const restored = new MySqlDatabase(restoredUrl.href);
    try {
      const command=spawnSync('mysql',['--protocol=tcp','-h',url.hostname,'-P',url.port||'3306','-u',decodeURIComponent(url.username),restoreName],
        {input:sql,env:{...process.env,MYSQL_PWD:decodeURIComponent(url.password)},maxBuffer:1024*1024});
      assert.equal(command.status,0,'MySQL client restore succeeded');
      const { databaseSnapshot } = await import('../helpers/database-snapshot.js');
      assert.equal(await databaseSnapshot(restored),await databaseSnapshot(database));
    } finally {await restored.close();await admin.exec(`DROP DATABASE \`${restoreName}\``);}
  });
  await t.test('two Redis clients enforce one atomic budget, expire it, and fail closed',async () => {
    const { createRedisRateLimiter } = await import('../../src/server/infrastructure/rate-limiter.js');
    const prefix=name+':';
    const a=await createRedisRateLimiter(process.env.REDIS_URL!,prefix), b=await createRedisRateLimiter(process.env.REDIS_URL!,prefix);
    try {
      const results=await Promise.all(Array.from({length:40},(_,i)=>(i%2?a:b).consume('login','fake-ip',10,2000)));
      assert.equal(results.filter(Boolean).length,10);
      await new Promise(r=>setTimeout(r,2100));
      assert.equal(await b.consume('login','fake-ip',10,2000),true);
      await a.close(); assert.equal(await a.ready(),false);
      await assert.rejects(a.consume('login','fake-ip',10),{statusCode:503});
    } finally {await a.close();await b.close();}
  });
});
