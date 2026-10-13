import fs from 'node:fs';
import os from 'node:os';
import { createHistogram, performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

const origin = new URL(process.env.BENCH_URL || 'http://127.0.0.1:8790');
if (!['http:','https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Invalid BENCH_URL');
if (!process.env.BENCH_ADMIN_PASSWORD) throw new Error('Set BENCH_ADMIN_PASSWORD for a staging administrator');
const concurrency = Number(process.env.BENCH_CONCURRENCY || 10);
const seconds = Number(process.env.BENCH_SECONDS || 15);
if (!Number.isInteger(concurrency)||concurrency<1||concurrency>200||!Number.isFinite(seconds)||seconds<1||seconds>300) throw new Error('Concurrency 1..200; seconds 1..300');
const login = await fetch(new URL('/api/admin/login',origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:process.env.BENCH_ADMIN_PASSWORD}),signal:AbortSignal.timeout(5000)});
if (!login.ok) throw new Error('Benchmark login failed');
const cookie = login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
if (!cookie) throw new Error('No session cookie');
const endpoint = '/api/v2/admin/accounts?limit=50';
async function request() {
  const response = await fetch(new URL(endpoint,origin),{headers:{cookie},signal:AbortSignal.timeout(10000)});
  const body = await response.json();
  if (!response.ok || !Array.isArray(body.results)) throw new Error('Invalid response');
  return body;
}
const sample = await request();
for (let i=0;i<5;i++) await request();
const latency = createHistogram();let completed=0,failed=0;
const start=performance.now(),until=start+seconds*1000;
await Promise.all(Array.from({length:concurrency},async()=>{
  while(performance.now()<until) {
    const before=performance.now();
    try {await request();completed++;}catch{failed++;}
    latency.record(Math.max(1,Math.round((performance.now()-before)*1000)));
  }
}));
const elapsed=(performance.now()-start)/1000;
let revision='unknown',dirty=true;try{revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();dirty=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());}catch{}
const report={server:process.env.BENCH_SERVER_DETAILS ? JSON.parse(process.env.BENCH_SERVER_DETAILS) : null,generatedAt:new Date().toISOString(),revision,dirtyWorktree:dirty,workload:'authenticated account list, 50 rows/page, 5 warmup requests',
  model:'closed-loop concurrent clients (not requests/second arrival rate)',datasetRows:Number(sample.total ?? sample.count ?? sample.results.length),concurrency,requestedSeconds:seconds,elapsedSeconds:elapsed,
  completed,failed,successfulRequestsPerSecond:completed/elapsed,errorRate:failed/(completed+failed),
  latencyMs:{p50:latency.percentile(50)/1000,p95:latency.percentile(95)/1000,p99:latency.percentile(99)/1000,max:latency.max/1000},
  loadGenerator:{node:process.version,platform:os.platform(),arch:os.arch(),cpus:os.cpus().length,memoryBytes:os.totalmem()},
  note:'Staging load test only. This is not a real user count or a production capacity guarantee. Record server limits and dependency versions separately.'};
const json=JSON.stringify(report,null,2)+'\n';
if(process.env.BENCH_OUTPUT) fs.writeFileSync(process.env.BENCH_OUTPUT,json,{mode:0o600});
console.log(json);
process.exitCode=failed ? 1 : 0;
