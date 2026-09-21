import fs from 'node:fs';
import path from 'node:path';
// Explicit administrator repair of known local IDs only. No mailbox listing,
// no stored body evidence, and never called by worker/startup/synchronization.
const args=process.argv.slice(2); const apply=args.includes('--apply');
const report=process.env.NOTICE_REPAIR_REPORT_DIRECTORY;
if(!report || !path.isAbsolute(report) || !process.env.DATABASE_PATH || !process.env.ENV_FILE || args.some(x=>x!=='--apply')) throw Error('explicit_paths_required');
if(fs.statSync(report).mode & 0o077)throw Error('private_report_required');
const {db}=await import('../src/server/db.js');
const {stableId}=await import('../src/server/association.js');
const {reprocessReviewedMail}=await import('../src/server/mail-sync.js');
const file=path.join(report,'notice-plan.json');
if(!apply){
 const rows=db.prepare(`SELECT m.id,m.provider_message_id,m.received_at FROM mail_messages m
   WHERE m.provider='shared-mail-api' AND m.category='deactivation'
   AND NOT EXISTS(SELECT 1 FROM mail_ownership_claims c WHERE c.message_id=m.id)
   ORDER BY m.received_at DESC LIMIT 51`).all() as any[];
 if(rows.length>50)throw Error('repair_batch_limit');
 fs.writeFileSync(file,JSON.stringify({createdAt:new Date().toISOString(),rows,maximumReads:rows.length*2},null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({mode:'preview',messages:rows.length,maximumReads:rows.length*2}));
}else{
 const plan=JSON.parse(fs.readFileSync(file,'utf8')); if(!Array.isArray(plan.rows)||plan.rows.length>50)throw Error('invalid_plan');
 const started=Date.now(); const results:any[]=[];
 const ledger=()=>db.prepare('SELECT COUNT(*) calls,COALESCE(SUM(rows_read),0) rowsRead FROM mail_read_requests').get() as any;
 const before=ledger();
 for(const row of plan.rows){
  if(Date.now()-started>180000){results.push({id:row.provider_message_id,status:'deadline_pending'});continue;}
  const reviewId=stableId('mail-review',row.id);
  const ready=db.transaction(()=>{
   const current=db.prepare(`SELECT id FROM mail_messages m WHERE id=? AND provider='shared-mail-api'
     AND provider_message_id=? AND category='deactivation'
     AND NOT EXISTS(SELECT 1 FROM mail_ownership_claims c WHERE c.message_id=m.id)`).get(row.id,row.provider_message_id);
   if(!current)return false;
   const old=db.prepare('SELECT status FROM pending_reviews WHERE id=?').get(reviewId) as any;
   if(old)return old.status==='pending';
   const now=new Date().toISOString();
   db.prepare(`INSERT INTO pending_reviews(id,review_type,candidate_email_hash,reason,evidence_json,created_at,updated_at)
     VALUES(?,'mail_ownership_ambiguous',?,'deactivation_owner_unresolved',?,?,?)`)
     .run(reviewId,stableId('repair-notice',row.id),JSON.stringify({messageId:row.id,repair:'admin-20260910'}),now,now);
   return true;
  }).immediate();
  if(!ready){results.push({id:row.provider_message_id,status:'state_changed_skipped'});continue;}
  try {const done=await reprocessReviewedMail(reviewId);results.push({id:row.provider_message_id,status:done.status,claims:done.claims,newBan:done.deactivated});}
  catch {results.push({id:row.provider_message_id,status:'pending_retry'});}
  console.log(JSON.stringify(results.at(-1)));
 }
 const after=ledger(); const summary={results,d1Calls:after.calls-before.calls,d1Rows:after.rowsRead-before.rowsRead,
   resolved:results.filter(r=>r.status==='resolved').length,newBans:results.filter(r=>r.newBan).length,pending:results.filter(r=>r.status.startsWith('pending')).length};
 fs.writeFileSync(path.join(report,'notice-applied.json'),JSON.stringify(summary,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({mode:'applied',...summary,results:undefined}));
}
db.close();
