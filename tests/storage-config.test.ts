import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRedisRateLimiter } from '../src/server/infrastructure/rate-limiter.js';

test('production refuses SQLite even when the test flag is supplied', () => {
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
    'await import("./src/server/db.ts")'],{encoding:'utf8',env:{...process.env,NODE_ENV:'production',
      ENV_FILE:'/dev/null',OPUS_SQLITE_TEST:'1',MYSQL_URL:'',V2_SESSION_SECRET:'fake-config-session',
      CREDENTIAL_ENCRYPTION_KEY:'fake-config-encryption'}});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/SQLite test backend is forbidden in production/);
});

test('Redis configuration cannot silently fall back to localhost',async()=>{
  await assert.rejects(createRedisRateLimiter('','test:'),/REDIS_URL is required/);
});
