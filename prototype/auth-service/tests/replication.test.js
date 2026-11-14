const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const {
  CacheService,
  RedisCacheStore,
  parseReplicationInfo,
} = require('../src/services/cacheService');
const { createAuditLogger } = require('../src/services/auditLogger');
const { createApp } = require('../src/app');
const { appendVerhoeffDigit } = require('../src/utils/verhoeff');
const { computeHmac } = require('../src/utils/crypto');

/**
 * Stateful in-memory mock mimicking Redis Primary -> Replica replication,
 * READONLY enforcement on replicas, and `REPLICAOF NO ONE` promotion.
 */
class MockRedisCluster {
  constructor() {
    this.primaryData = new Map();
    this.replicaData = new Map();
    this.primaryOnline = true;
    this.replicaPromoted = false;
    this.replicaOfCalls = 0;
    this.waitCalls = 0;
  }

  _purgeExpired(map, key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      map.delete(key);
      return null;
    }
    return entry;
  }

  createClient(nodeRole) {
    const cluster = this;
    const isPrimaryNode = nodeRole === 'primary';

    return {
      on() {},

      async ping() {
        if (isPrimaryNode && !cluster.primaryOnline) {
          const err = new Error('connect ECONNREFUSED 172.20.0.2:6379');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        return 'PONG';
      },

      async info(section) {
        if (section !== 'replication') return '';
        if (isPrimaryNode) {
          return [
            '# Replication',
            'role:master',
            `connected_slaves:${cluster.replicaPromoted ? 0 : 1}`,
            'master_repl_offset:4200',
          ].join('\r\n');
        }
        if (cluster.replicaPromoted) {
          return [
            '# Replication',
            'role:master',
            'connected_slaves:0',
            'master_repl_offset:4200',
          ].join('\r\n');
        }
        return [
          '# Replication',
          'role:slave',
          'master_host:redis_region1',
          'master_port:6379',
          `master_link_status:${cluster.primaryOnline ? 'up' : 'down'}`,
          'slave_repl_offset:4200',
        ].join('\r\n');
      },

      async set(key, value, ...args) {
        if (isPrimaryNode) {
          if (!cluster.primaryOnline) {
            const err = new Error('connect ECONNREFUSED 172.20.0.2:6379');
            err.code = 'ECONNREFUSED';
            throw err;
          }
          const isNx = args.includes('NX');
          const exIdx = args.indexOf('EX');
          const ttlSec = exIdx !== -1 ? Number(args[exIdx + 1]) : 300;
          cluster._purgeExpired(cluster.primaryData, key);
          if (isNx && cluster.primaryData.has(key)) return null;

          const record = { value, expiresAt: Date.now() + ttlSec * 1000 };
          cluster.primaryData.set(key, record);
          // Replicate asynchronously into replica if still linked
          if (!cluster.replicaPromoted) {
            cluster.replicaData.set(key, { ...record });
          }
          return 'OK';
        }

        // Replica node
        if (!cluster.replicaPromoted) {
          throw new Error("READONLY You can't write against a read only replica.");
        }
        const isNx = args.includes('NX');
        const exIdx = args.indexOf('EX');
        const ttlSec = exIdx !== -1 ? Number(args[exIdx + 1]) : 300;
        cluster._purgeExpired(cluster.replicaData, key);
        if (isNx && cluster.replicaData.has(key)) return null;

        cluster.replicaData.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
        return 'OK';
      },

      async call(cmd, ...args) {
        const upper = String(cmd).toUpperCase();
        if (upper === 'REPLICAOF' && args[0] === 'NO' && args[1] === 'ONE') {
          if (!isPrimaryNode) {
            cluster.replicaOfCalls += 1;
            cluster.replicaPromoted = true;
          }
          return 'OK';
        }

        if (upper === 'WAIT') {
          cluster.waitCalls += 1;
          return cluster.replicaPromoted ? 0 : 1;
        }

        if (upper === 'GETDEL') {
          const key = args[0];
          if (isPrimaryNode) {
            if (!cluster.primaryOnline) {
              const err = new Error('Connection is closed.');
              throw err;
            }
            const entry = cluster._purgeExpired(cluster.primaryData, key);
            if (!entry) return null;
            cluster.primaryData.delete(key);
            if (!cluster.replicaPromoted) {
              cluster.replicaData.delete(key);
            }
            return entry.value;
          }

          if (!cluster.replicaPromoted) {
            throw new Error("READONLY You can't write against a read only replica.");
          }
          const entry = cluster._purgeExpired(cluster.replicaData, key);
          if (!entry) return null;
          cluster.replicaData.delete(key);
          return entry.value;
        }

        throw new Error(`Unsupported mock command: ${cmd}`);
      },

      async quit() {
        return 'OK';
      },
    };
  }
}

function buildSignedRequest(secret, bodyObj, timestampOverride) {
  const rawBody = JSON.stringify(bodyObj);
  const timestamp = String(timestampOverride ?? Math.floor(Date.now() / 1000));
  const signature = computeHmac(secret, `${timestamp}.${rawBody}`);
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-timestamp': timestamp,
      'x-signature': signature,
    },
  };
}

test('parseReplicationInfo parses primary and replica INFO output', () => {
  const primary = parseReplicationInfo(
    '# Replication\r\nrole:master\r\nconnected_slaves:1\r\nmaster_repl_offset:1024\r\n'
  );
  assert.equal(primary.role, 'master');
  assert.equal(primary.connectedSlaves, 1);
  assert.equal(primary.replOffset, 1024);

  const replica = parseReplicationInfo(
    '# Replication\nrole:slave\nmaster_host:redis_region1\nmaster_port:6379\nmaster_link_status:up\nslave_repl_offset:1024\n'
  );
  assert.equal(replica.role, 'slave');
  assert.equal(replica.masterHost, 'redis_region1');
  assert.equal(replica.masterPort, 6379);
  assert.equal(replica.masterLinkStatus, 'up');
  assert.equal(replica.replOffset, 1024);
});

test('RedisCacheStore invokes WAIT when waitReplicas > 0 and skips after promotion', async () => {
  const cluster = new MockRedisCluster();
  const store = new RedisCacheStore({
    redisUrl: 'redis://redis_region2:6379',
    redisPrimaryUrl: 'redis://redis_region1:6379',
    waitReplicas: 1,
    waitTimeoutMs: 50,
    createClient: (url) =>
      cluster.createClient(url.includes('region1') ? 'primary' : 'replica'),
  });

  await store.setWithTtl('otp:t1', '{"uidHash":"a","otpHash":"b"}', 300);
  assert.equal(cluster.waitCalls, 1);

  cluster.primaryOnline = false;
  await store.setWithTtl('otp:t2', '{"uidHash":"c","otpHash":"d"}', 300);
  assert.equal(store.promoted, true);
  assert.equal(cluster.waitCalls, 1);
  await store.close();
});

test('Concurrent primary failure promotes local replica exactly once', async () => {
  const cluster = new MockRedisCluster();
  const store = new RedisCacheStore({
    redisUrl: 'redis://redis_region2:6379',
    redisPrimaryUrl: 'redis://redis_region1:6379',
    createClient: (url) =>
      cluster.createClient(url.includes('region1') ? 'primary' : 'replica'),
  });

  cluster.primaryOnline = false;

  const locks = await Promise.all(
    Array.from({ length: 10 }, (_, idx) =>
      store.setNxWithTtl(`replay:sig-${idx}`, '1', 60)
    )
  );

  assert.equal(locks.every(Boolean), true);
  assert.equal(cluster.replicaOfCalls, 1);
  assert.equal(store.promoted, true);
  await store.close();
});

test('Dual-region HTTP flow supports cross-region verify, replay block, and Redis primary outage failover', async () => {
  const cluster = new MockRedisCluster();
  const validUid = appendVerhoeffDigit('99991111222');

  const r1Store = new RedisCacheStore({
    redisUrl: 'redis://redis_region1:6379',
    redisPrimaryUrl: 'redis://redis_region1:6379',
    createClient: () => cluster.createClient('primary'),
  });
  const r2Store = new RedisCacheStore({
    redisUrl: 'redis://redis_region2:6379',
    redisPrimaryUrl: 'redis://redis_region1:6379',
    createClient: (url) =>
      cluster.createClient(url.includes('region1') ? 'primary' : 'replica'),
  });

  const cfg1 = loadConfig({
    REGION: 'mumbai',
    INSTANCE_ID: 'mumbai-auth-1',
    DEMO_RETURN_OTP: 'true',
    LOG_MOCK_SMS: 'false',
  });
  const cfg2 = loadConfig({
    REGION: 'hyderabad',
    INSTANCE_ID: 'hyderabad-auth-1',
    DEMO_RETURN_OTP: 'true',
    LOG_MOCK_SMS: 'false',
  });

  const app1 = createApp({
    config: cfg1,
    cacheService: new CacheService(r1Store, 'redis'),
    auditLogger: createAuditLogger({ enabled: false }),
  });
  const app2 = createApp({
    config: cfg2,
    cacheService: new CacheService(r2Store, 'redis'),
    auditLogger: createAuditLogger({ enabled: false }),
  });

  const srv1 = await new Promise((resolve) => {
    const s = app1.listen(0, () => resolve(s));
  });
  const srv2 = await new Promise((resolve) => {
    const s = app2.listen(0, () => resolve(s));
  });

  const url1 = `http://127.0.0.1:${srv1.address().port}`;
  const url2 = `http://127.0.0.1:${srv2.address().port}`;

  try {
    // 1. Check /health replication metadata across regions
    const h1 = await (await fetch(`${url1}/health`)).json();
    const h2 = await (await fetch(`${url2}/health`)).json();
    assert.equal(h1.replication.role, 'master');
    assert.equal(h2.replication.role, 'slave');
    assert.equal(h2.replication.mode, 'dual-region');
    assert.equal(h2.replication.masterLinkStatus, 'up');

    // 2. Generate OTP in Mumbai, verify in Hyderabad
    const genReq = buildSignedRequest(cfg1.hmacSecret, { uid: validUid });
    const genRes = await fetch(`${url1}/auth/otp/generate`, {
      method: 'POST',
      headers: genReq.headers,
      body: genReq.rawBody,
    });
    assert.equal(genRes.status, 200);
    const genBody = await genRes.json();

    // Cross-region replay of exact same signed request against Hyderabad must fail with 403
    const crossReplay = await fetch(`${url2}/auth/otp/generate`, {
      method: 'POST',
      headers: genReq.headers,
      body: genReq.rawBody,
    });
    assert.equal(crossReplay.status, 403);

    const verifyReq = buildSignedRequest(cfg2.hmacSecret, {
      uid: validUid,
      txnId: genBody.txnId,
      otp: genBody.demoOtp,
    });
    const verifyRes = await fetch(`${url2}/auth/verify`, {
      method: 'POST',
      headers: verifyReq.headers,
      body: verifyReq.rawBody,
    });
    assert.equal(verifyRes.status, 200);
    assert.equal((await verifyRes.json()).authStatus, 'Y');

    // 3. Generate another OTP in Mumbai, then simulate catastrophic Region 1 Redis outage
    const gen2Req = buildSignedRequest(
      cfg1.hmacSecret,
      { uid: validUid },
      Math.floor(Date.now() / 1000) + 1
    );
    const gen2Body = await (
      await fetch(`${url1}/auth/otp/generate`, {
        method: 'POST',
        headers: gen2Req.headers,
        body: gen2Req.rawBody,
      })
    ).json();

    // Primary Redis goes down; Hyderabad must auto-promote local replica & preserve replicated OTP
    cluster.primaryOnline = false;

    const verify2Req = buildSignedRequest(
      cfg2.hmacSecret,
      {
        uid: validUid,
        txnId: gen2Body.txnId,
        otp: gen2Body.demoOtp,
      },
      Math.floor(Date.now() / 1000) + 2
    );
    const verify2Res = await fetch(`${url2}/auth/verify`, {
      method: 'POST',
      headers: verify2Req.headers,
      body: verify2Req.rawBody,
    });
    assert.equal(verify2Res.status, 200);
    assert.equal((await verify2Res.json()).authStatus, 'Y');

    const h2After = await (await fetch(`${url2}/health`)).json();
    assert.equal(h2After.replication.promoted, true);
    assert.equal(h2After.replication.role, 'master');
  } finally {
    await new Promise((resolve) => srv1.close(resolve));
    await new Promise((resolve) => srv2.close(resolve));
    await r1Store.close();
    await r2Store.close();
  }
});

