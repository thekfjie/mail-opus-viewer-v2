import crypto from 'node:crypto';
import { createClient } from 'redis';

export interface RateLimiter {
  consume(scope: string, identity: string, max: number, windowMs?: number): Promise<boolean>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
const consumeScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;
/** One atomic increment+expiry across every API instance. No tokens, mail or IPs are stored. */
export async function createRedisRateLimiter(url: string, prefix: string): Promise<RateLimiter> {
  if (!url) throw new Error("REDIS_URL is required");
  const client = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 3000,
    reconnectStrategy: retries => Math.min(100 * 2 ** Math.min(retries, 5), 3000) } });
  client.on('error', () => {}); // readiness reports failure; connection errors may contain credentials.
  const deadline = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Rate limiter unavailable')),2000);
    operation.then(resolve,reject).finally(()=>clearTimeout(timer));
  });
  try { await deadline(client.connect()); } catch { client.destroy(); throw new Error('Redis is unavailable'); }
  return {
    async consume(scope, identity, max, windowMs = 600_000) {
      if (!Number.isInteger(max)||max<1||!Number.isInteger(windowMs)||windowMs<1)throw new Error('Invalid rate limit');
      const hash=crypto.createHash('sha256').update(scope+'\0'+identity).digest('hex');
      try {
        const count=await deadline(client.eval(consumeScript,{keys:[prefix+'rate:'+hash],arguments:[String(windowMs)]}));
        return Number(count)<=max;
      } catch { throw Object.assign(new Error('请求限流服务暂时不可用，请稍后重试'),{statusCode:503}); }
    },
    async ready() { try {return await deadline(client.ping())==='PONG';}catch{return false;} },
    async close() { if(client.isOpen)client.destroy(); },
  };
}
/** Test fixture only; production never silently falls back to per-process counters. */
export function memoryRateLimiter(): RateLimiter {
  const buckets=new Map<string,{count:number;until:number}>();
  return {
    async consume(scope,identity,max,windowMs=600_000){
      const now=Date.now();for(const [key,b]of buckets)if(b.until<=now)buckets.delete(key);
      const key=scope+':'+identity;const b=buckets.get(key)??{count:0,until:now+windowMs};
      buckets.set(key,b);return ++b.count<=max;
    },
    async ready(){return true;},async close(){buckets.clear();},
  };
}
