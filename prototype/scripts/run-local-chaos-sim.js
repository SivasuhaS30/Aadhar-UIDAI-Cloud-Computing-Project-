const http = require('http');
const path = require('path');

const { loadConfig } = require('../auth-service/src/config');
const { CacheService, RedisCacheStore } = require('../auth-service/src/services/cacheService');
const { createAuditLogger } = require('../auth-service/src/services/auditLogger');
const { createApp } = require('../auth-service/src/app');
const { runChaosMonitor } = require('./chaos-monitor');

class SimulatedMultiAzRedis {
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
          return `role:master\r\nconnected_slaves:${self.replicaPromoted ? 0 : 1}\r\nmaster_repl_offset:200\r\n`;
        }
        return `role:slave\r\nmaster_host:zone-a-redis\r\nmaster_port:6379\r\nmaster_link_status:${self.primaryOnline ? 'up' : 'down'}\r\n`;
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
        if (!self.replicaPromoted) throw new Error("READONLY You can't write against a read only replica.");
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
          if (!self.replicaPromoted) throw new Error("READONLY You can't write against a read only replica.");
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

function createFailoverLoadBalancer(targets) {
  let cursor = 0;

  function forwardTo(targetPort, req, bodyBuffer) {
    return new Promise((resolve, reject) => {
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            resolve({
              statusCode: proxyRes.statusCode,
              headers: proxyRes.headers,
              body: Buffer.concat(chunks),
            });
          });
        }
      );
      proxyReq.on('error', reject);
      if (bodyBuffer.length) proxyReq.write(bodyBuffer);
      proxyReq.end();
    });
  }

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const bodyBuffer = Buffer.concat(chunks);
      const startIdx = cursor % targets.length;
      cursor += 1;

      for (let attempt = 0; attempt < targets.length; attempt += 1) {
        const target = targets[(startIdx + attempt) % targets.length];
        try {
          const resp = await forwardTo(target.port, req, bodyBuffer);
          if (resp.statusCode >= 502 && attempt < targets.length - 1) continue;
          res.writeHead(resp.statusCode, resp.headers);
          res.end(resp.body);
          return;
        } catch {
          // Transparently retry on next healthy zone (mimics proxy_next_upstream / ALB failover)
        }
      }

      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'BAD_GATEWAY' }));
    });
  });
}

async function main() {
  const cluster = new SimulatedMultiAzRedis();
  const rA = new RedisCacheStore({
    redisUrl: 'redis://zone-a:6379',
    redisPrimaryUrl: 'redis://zone-a:6379',
    createClient: () => cluster.createClient('primary'),
  });
  const rB = new RedisCacheStore({
    redisUrl: 'redis://zone-b:6379',
    redisPrimaryUrl: 'redis://zone-a:6379',
    createClient: (u) => cluster.createClient(u.includes('zone-a') ? 'primary' : 'replica'),
  });

  const cfgA = loadConfig({
    REGION: 'ap-south-1a',
    INSTANCE_ID: 'az1a-local-sim',
    DEMO_RETURN_OTP: 'true',
    LOG_MOCK_SMS: 'false',
  });
  const cfgB = loadConfig({
    REGION: 'ap-south-1b',
    INSTANCE_ID: 'az1b-local-sim',
    DEMO_RETURN_OTP: 'true',
    LOG_MOCK_SMS: 'false',
  });

  const appA = createApp({
    config: cfgA,
    cacheService: new CacheService(rA, 'redis'),
    auditLogger: createAuditLogger({ enabled: false }),
  });
  const appB = createApp({
    config: cfgB,
    cacheService: new CacheService(rB, 'redis'),
    auditLogger: createAuditLogger({ enabled: false }),
  });

  const srvA = await new Promise((r) => {
    const s = appA.listen(0, '127.0.0.1', () => r(s));
  });
  const srvB = await new Promise((r) => {
    const s = appB.listen(0, '127.0.0.1', () => r(s));
  });

  const targets = [
    { zone: 'ap-south-1a', port: srvA.address().port },
    { zone: 'ap-south-1b', port: srvB.address().port },
  ];
  const lb = createFailoverLoadBalancer(targets);
  await new Promise((r) => lb.listen(0, '127.0.0.1', r));
  const lbUrl = `http://127.0.0.1:${lb.address().port}`;

  let zoneAKilled = false;

  try {
    const summary = await runChaosMonitor({
      url: lbUrl,
      intervalMs: 120,
      durationSec: 30,
      maxTicks: 12,
      hmacSecret: cfgA.hmacSecret,
      outDir: path.resolve(__dirname, '../results'),
      tag: 'local-sim',
      onTick: async (sample) => {
        if (sample.seq === 5 && !zoneAKilled) {
          zoneAKilled = true;
          console.log('\n[CHAOS EVENT] Terminating Zone A (ap-south-1a compute + Primary Redis)...\n');
          cluster.primaryOnline = false;
          if (typeof srvA.closeAllConnections === 'function') srvA.closeAllConnections();
          await new Promise((resolve) => srvA.close(resolve));
        }
      },
    });

    if (summary.healthAvailabilityPct !== 100 || summary.authFailureCount !== 0 || !summary.promotionObserved) {
      throw new Error('Local chaos simulation did not meet 100% failover + promotion expectation');
    }
  } finally {
    await new Promise((r) => lb.close(r));
    if (!zoneAKilled) await new Promise((r) => srvA.close(r));
    await new Promise((r) => srvB.close(r));
    await rA.close();
    await rB.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
