import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';

/** MySQL consistent logical backup. Run with MySQL's mysqldump 8.x installed. */
export async function backupMySql(urlString: string, directory: string) {
  const url = new URL(urlString);
  if (url.protocol !== 'mysql:' || !/^\/[A-Za-z0-9_]+$/.test(url.pathname) || url.search) throw new Error('Backup requires a plain mysql:// URL and simple database name; use a configured MySQL client for custom TLS');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(),'opus-backup-'));
  fs.chmodSync(privateDir,0o700);
  const quote = (s:string) => '"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n').replaceAll('\r','\\r')+'"';
  const options = path.join(privateDir,'client.cnf');
  fs.writeFileSync(options,`[client]\nhost=${quote(url.hostname)}\nport=${url.port||3306}\nuser=${quote(decodeURIComponent(url.username))}\npassword=${quote(decodeURIComponent(url.password))}\nprotocol=tcp\n`,{mode:0o600});
  const name = `opusmail.${new Date().toISOString().replaceAll(':','-')}.${crypto.randomBytes(3).toString('hex')}.sql.gz`;
  const destination = path.join(directory,name), temporary = destination+'.tmp';
  try {
    const child = spawn('mysqldump',[`--defaults-extra-file=${options}`,'--single-transaction','--quick','--no-tablespaces','--set-gtid-purged=OFF','--column-statistics=0','--hex-blob','--default-character-set=utf8mb4',url.pathname.slice(1)],{stdio:['ignore','pipe','ignore']});
    // Never log driver/client stderr: it may contain values from failed statements.
    const completed = new Promise<void>((resolve,reject)=>{
      child.on('error',()=>reject(new Error('mysqldump could not start; install the MySQL 8.x client')));
      child.on('close',code=>code===0?resolve():reject(new Error('mysqldump failed; backup was not published')));
    });
    try {
      await Promise.all([completed,pipeline(child.stdout,createGzip(),fs.createWriteStream(temporary,{flags:'wx',mode:0o600}))]);
    } catch(error) { child.kill(); await completed.catch(()=>{}); throw error; }
    fs.renameSync(temporary,destination);
    return {backup:name,bytes:fs.statSync(destination).size};
  } finally { fs.rmSync(temporary,{force:true});fs.rmSync(privateDir,{recursive:true,force:true}); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
  try {
    if(!config.mysqlUrl)throw new Error('MYSQL_URL is required');
    console.log(JSON.stringify({ok:true,...await backupMySql(config.mysqlUrl,process.env.V2_BACKUP_DIRECTORY || path.join(config.projectRoot,'.state','backups'))}));
  } catch(error) { console.error((error as Error).message);process.exitCode=1; }
}
