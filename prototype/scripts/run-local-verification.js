const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const { loadConfig } = require('../auth-service/src/config');
const { CacheService, RedisCacheStore } = require('../auth-service/src/services/cacheService');
const { createAuditLogger } = require('../auth-service/src/services/auditLogger');
const { createApp } = require('../auth-service/src/app');
const { appendVerhoeffDigit } = require('../auth-service/src/utils/verhoeff');
const { computeHmac, decryptAesGcm } = require('../auth-service/src/utils/crypto');

class LocalReplicatedRedisMock {
  constructor() {
    this.primaryData = new Map();
    this.replicaData = new Map();
    this.primaryOnline = true;
    this.replicaPromoted = false;
  }

  _purge(map, key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      map.delete(key);
      return null;
    }
    return entry;
  }

  createClient(role) {
    const self = this;
    const isPrimary = role === 'primary';
    return {
      on() {},
      async ping() {
        if (isPrimary && !self.primaryOnline) {
          const err = new Error('connect ECONNREFUSED');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        return 'PONG';
      },
      async info(section) {
        if (section !== 'replication') return '';
        if (isPrimary || self.replicaPromoted) {
          return `role:master\r\nconnected_slaves:${self.replicaPromoted ? 0 : 1}\r\nmaster_repl_offset:100\r\n`;
        }
        return `role:slave\r\nmaster_host:redis_region1\r\nmaster_port:6379\r\nmaster_link_status:${self.primaryOnline ? 'up' : 'down'}\r\n`;
      },
      async set(key, value, ...args) {
        const isNx = args.includes('NX');
        const exIdx = args.indexOf('EX');
        const ttlSec = exIdx !== -1 ? Number(args[exIdx + 1]) : 300;
        if (isPrimary) {
          if (!self.primaryOnline) {
            const err = new Error('connect ECONNREFUSED');
            err.code = 'ECONNREFUSED';
            throw err;
          }
          self._purge(self.primaryData, key);
          if (isNx && self.primaryData.has(key)) return null;
          const rec = { value, expiresAt: Date.now() + ttlSec * 1000 };
          self.primaryData.set(key, rec);
          if (!self.replicaPromoted) self.replicaData.set(key, { ...rec });
          return 'OK';
        }
        if (!self.replicaPromoted) {
          throw new Error("READONLY You can't write against a read only replica.");
        }
        self._purge(self.replicaData, key);
        if (isNx && self.replicaData.has(key)) return null;
        self.replicaData.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
        return 'OK';
      },
      async call(cmd, ...args) {
        const upper = String(cmd).toUpperCase();
        if (upper === 'REPLICAOF' && args[0] === 'NO' && args[1] === 'ONE') {
          if (!isPrimary) self.replicaPromoted = true;
          return 'OK';
        }
        if (upper === 'GETDEL') {
          const key = args[0];
          if (isPrimary) {
            if (!self.primaryOnline) throw new Error('Connection is closed.');
            const rec = self._purge(self.primaryData, key);
            if (!rec) return null;
            self.primaryData.delete(key);
            if (!self.replicaPromoted) self.replicaData.delete(key);
            return rec.value;
          }
          if (!self.replicaPromoted) {
            throw new Error("READONLY You can't write against a read only replica.");
          }
          const rec = self._purge(self.replicaData, key);
          if (!rec) return null;
          self.replicaData.delete(key);
          return rec.value;
        }
        throw new Error(`Unsupported command ${cmd}`);
      },
      async quit() {
        return 'OK';
      },
    };
  }
}

function buildSignedRequest(secret, payload) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
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

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[idx].toFixed(2));
}

async function main() {
  const cluster = new LocalReplicatedRedisMock();
  const r1Store = new RedisCacheStore({
    redisUrl: 'redis://redis_region1:6379',
    redisPrimaryUrl: 'redis://redis_region1:6379',
    createClient: () => cluster.createClient('primary'),
  });
  const r2Store = new RedisCacheStore({
    redisUrl: 'redis://redis_region2:6379',
    redisPrimaryUrl: 'redis://redis_region1:6379',
    createClient: (u) => cluster.createClient(u.includes('region1') ? 'primary' : 'replica'),
  });

  const cfg1 = loadConfig({
    REGION: 'mumbai',
    INSTANCE_ID: 'mumbai-local-1',
    DEMO_RETURN_OTP: 'true',
    LOG_MOCK_SMS: 'false',
  });
  const cfg2 = loadConfig({
    REGION: 'hyderabad',
    INSTANCE_ID: 'hyderabad-local-1',
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
    const s = app1.listen(0, '127.0.0.1', () => resolve(s));
  });
  const srv2 = await new Promise((resolve) => {
    const s = app2.listen(0, '127.0.0.1', () => resolve(s));
  });

  const url1 = `http://127.0.0.1:${srv1.address().port}`;
  const url2 = `http://127.0.0.1:${srv2.address().port}`;
  const urls = [url1, url2];

  const report = {
    executedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    environmentNote:
      'Local Node.js loopback simulation with stateful Primary->Replica Redis mock (not Docker/AWS EC2)',
    smokeChecks: {},
    loopbackBenchmark: {},
  };

  try {
    // Smoke checks
    const h1 = await (await fetch(`${url1}/health`)).json();
    const h2 = await (await fetch(`${url2}/health`)).json();
    const uid = appendVerhoeffDigit('99991111222');

    const genReq = buildSignedRequest(cfg1.hmacSecret, { uid, nonce: 'smoke-1' });
    const genRes = await fetch(`${url1}/auth/otp/generate`, {
      method: 'POST',
      headers: genReq.headers,
      body: genReq.rawBody,
    });
    const genBody = await genRes.json();

    const replayRes = await fetch(`${url2}/auth/otp/generate`, {
      method: 'POST',
      headers: genReq.headers,
      body: genReq.rawBody,
    });
    const replayBody = await replayRes.json();

    const verReq = buildSignedRequest(cfg2.hmacSecret, {
      uid,
      txnId: genBody.txnId,
      otp: genBody.demoOtp,
      nonce: 'smoke-2',
    });
    const verRes = await fetch(`${url2}/auth/verify`, {
      method: 'POST',
      headers: verReq.headers,
      body: verReq.rawBody,
    });
    const verBody = await verRes.json();
    const decrypted = decryptAesGcm(cfg2.aesKeyBuffer, verBody.encryptedAssertion);

    // Loopback concurrency micro-benchmark (10 concurrent workers, 250 OTP generate+verify pairs = 500 requests)
    const workers = 10;
    const pairsPerWorker = 25;
    const latencies = [];
    let successCount = 0;
    let errorCount = 0;

    const benchStart = performance.now();
    await Promise.all(
      Array.from({ length: workers }, async (_, wIdx) => {
        for (let i = 0; i < pairsPerWorker; i += 1) {
          const iterUid = appendVerhoeffDigit(String(90000000000 + wIdx * 1000 + i));
          const reqUrlGen = urls[(wIdx + i) % 2];
          const reqUrlVer = urls[(wIdx + i + 1) % 2];

          const t0 = performance.now();
          const gReq = buildSignedRequest(cfg1.hmacSecret, {
            uid: iterUid,
            nonce: `w${wIdx}-i${i}`,
          });
          const gRes = await fetch(`${reqUrlGen}/auth/otp/generate`, {
            method: 'POST',
            headers: gReq.headers,
            body: gReq.rawBody,
          });
          latencies.push(performance.now() - t0);
          if (gRes.status !== 200) {
            errorCount += 1;
            continue;
          }
          successCount += 1;
          const gData = await gRes.json();

          const t1 = performance.now();
          const vReq = buildSignedRequest(cfg1.hmacSecret, {
            uid: iterUid,
            txnId: gData.txnId,
            otp: gData.demoOtp,
            nonce: `w${wIdx}-i${i}-v`,
          });
          const vRes = await fetch(`${reqUrlVer}/auth/verify`, {
            method: 'POST',
            headers: vReq.headers,
            body: vReq.rawBody,
          });
          latencies.push(performance.now() - t1);
          const vData = await vRes.json();
          if (vRes.status === 200 && vData.authStatus === 'Y') {
            successCount += 1;
          } else {
            errorCount += 1;
          }
        }
      })
    );
    const totalSec = (performance.now() - benchStart) / 1000;
    latencies.sort((a, b) => a - b);

    // Failover promotion check at the end
    const preFailoverGenReq = buildSignedRequest(cfg1.hmacSecret, { uid, nonce: 'failover-pre' });
    const preFailoverGen = await (
      await fetch(`${url1}/auth/otp/generate`, {
        method: 'POST',
        headers: preFailoverGenReq.headers,
        body: preFailoverGenReq.rawBody,
      })
    ).json();

    cluster.primaryOnline = false;

    const postFailoverVerReq = buildSignedRequest(cfg2.hmacSecret, {
      uid,
      txnId: preFailoverGen.txnId,
      otp: preFailoverGen.demoOtp,
      nonce: 'failover-post',
    });
    const postFailoverRes = await fetch(`${url2}/auth/verify`, {
      method: 'POST',
      headers: postFailoverVerReq.headers,
      body: postFailoverVerReq.rawBody,
    });
    const postFailoverBody = await postFailoverRes.json();
    const h2After = await (await fetch(`${url2}/health`)).json();

    report.smokeChecks = {
      region1Health: { status: h1.status, region: h1.region, replication: h1.replication },
      region2HealthBeforeFailover: { status: h2.status, region: h2.region, replication: h2.replication },
      otpGenerateStatus: genRes.status,
      crossRegionReplayStatus: replayRes.status,
      crossRegionReplayError: replayBody.error,
      crossRegionVerifyStatus: verRes.status,
      authStatus: verBody.authStatus,
      aesDecryptedAuthStatus: decrypted.authStatus,
      primaryOutageFailoverVerifyStatus: postFailoverRes.status,
      region2HealthAfterFailover: {
        status: h2After.status,
        region: h2After.region,
        replication: h2After.replication,
      },
      failoverPreservedOtp: postFailoverBody.authStatus === 'Y' && h2After.replication.promoted === true,
    };

    report.loopbackBenchmark = {
      concurrencyVUs: workers,
      totalRequests: successCount + errorCount,
      successfulRequests: successCount,
      failedRequests: errorCount,
      durationSec: Number(totalSec.toFixed(3)),
      throughputRps: Number(((successCount + errorCount) / totalSec).toFixed(1)),
      latencyMs: {
        min: Number(latencies[0].toFixed(2)),
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: Number(latencies[latencies.length - 1].toFixed(2)),
      },
    };

    const resultsDir = path.resolve(__dirname, '../results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const outPath = path.join(resultsDir, 'local-verification-results.json');
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify(report, null, 2));
    console.log(`\nSaved verification results to ${outPath}`);
  } finally {
    await new Promise((resolve) => srv1.close(resolve));
    await new Promise((resolve) => srv2.close(resolve));
    await r1Store.close();
    await r2Store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

