import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MySqlDatabase } from '../src/server/storage/mysql.js';

if(!process.env.MYSQL_URL||!process.env.REDIS_URL)throw new Error('Use a disposable MySQL/Redis test server');
if(process.env.OPUS_SQLITE_TEST==='1')throw new Error('MySQL fixture cannot use SQLite');
const rows=Number(process.env.FIXTURE_ROWS||500);
if(!Number.isInteger(rows)||rows<50||rows>10000)throw new Error('FIXTURE_ROWS must be 50..10000');
const name='opus_bench_'+crypto.randomBytes(6).toString('hex');
const admin=new MySqlDatabase(process.env.MYSQL_URL);
const url=new URL(process.env.MYSQL_URL);url.pathname='/'+name;
await admin.exec(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
Object.assign(process.env,{MYSQL_URL:url.href,ENV_FILE:'/dev/null',V2_SESSION_SECRET:'fake-benchmark-session',
 CREDENTIAL_ENCRYPTION_KEY:'fake-benchmark-key',VIEWER_ADMIN_PASSWORD:'fake-benchmark-password',
 V2_READ_ONLY:'false',V2_AUTO_TRIAL_ENABLED:'false',PUBLIC_ORIGIN:'http://127.0.0.1'});
const database=new MySqlDatabase(url.href);
let db: any,app: any;
try {
 const {migrateMySql}=await import('../src/server/storage/migrate.js');await migrateMySql(database);
 ({db}=await import('../src/server/db.js'));
 const repo=await import('../src/server/repository.js');
 for(let offset=0;offset<rows;offset+=100){
  const result=await repo.importAccounts(Array.from({length:Math.min(100,rows-offset)},(_,n)=>({email:`bench${offset+n}@icloud.com`,note:'Synthetic benchmark fixture',accessToken:`fake-benchmark-token-${offset+n}`})));
  if(result.errors.length)throw new Error('Fixture import failed');
 }
 const accounts=await db.prepare('SELECT id FROM gpt_accounts ORDER BY id').all();
 if(accounts.length!==rows)throw new Error('Fixture row count mismatch');
 const at='2026-01-01T00:00:00.000Z';
 await db.transaction(async()=>{
  for (const [i,account] of accounts.entries()) {
   const binding=await db.prepare('SELECT id FROM email_bindings WHERE account_id=? AND is_current=1').get(account.id);
   await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,category,is_security,indexed_at)
     VALUES(?,'shared-mail-api',?,'Synthetic sender','','Synthetic message',?,'other',0,?)`).run('mail-'+i,String(i),at,at);
   await db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
     VALUES(?,?,?,'exact','fixture',0,?)`).run('mail-'+i,account.id,binding.id,at);
  }
 })();
 // Refresh optimizer statistics after bulk loading so short runs do not measure
 // the transition from empty-table estimates to background auto-analysis.
 const { importTables } = await import('../src/server/storage/schema-v1.js');
 for (const table of importTables) await database.exec(`ANALYZE TABLE \`${table.name}\``);
 const {buildApp}=await import('../src/server/server.js');app=await buildApp();
 const origin=await app.listen({host:'127.0.0.1',port:0});
 const mysql=(await database.prepare('SELECT VERSION() version').get()).version;
 const sourceHash=crypto.createHash('sha256');
 const visit=(directory:string)=>{for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,item.name);if(item.isDirectory())visit(file);else sourceHash.update(file).update(fs.readFileSync(file));}};
 visit('src/server');sourceHash.update(fs.readFileSync('package-lock.json'));
 const details=JSON.stringify({environment:'shared development sandbox; client and server on same host',mysql,
  dataset:{accounts:rows,credentials:rows,messages:rows,ownershipClaims:rows},mysqlPool:10,apiProcesses:1,workerProcesses:0,sourceSha256:sourceHash.digest('hex')});
 fs.mkdirSync('docs/benchmarks',{recursive:true});
 for(const concurrency of (process.env.BENCH_CONCURRENCY||'1,10').split(',')){
  const code=await new Promise<number>(resolve=>{
   const child=spawn(process.execPath,['scripts/benchmark.mjs'],{stdio:'inherit',env:{...process.env,
    BENCH_URL:origin,BENCH_ADMIN_PASSWORD:'fake-benchmark-password',BENCH_SECONDS:process.env.BENCH_SECONDS||'10',BENCH_CONCURRENCY:concurrency,
    BENCH_SERVER_DETAILS:details,BENCH_OUTPUT:`docs/benchmarks/local-c${concurrency}.json`}});
   child.on('error',()=>resolve(1));child.on('close',code=>resolve(code??1));
  });
  if(code)process.exitCode=1;
 }
}finally{
 if(app)await app.close();if(db)await db.close();await database.close();
 await admin.exec(`DROP DATABASE \`${name}\``);await admin.close();
}
