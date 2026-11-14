const Redis = require('ioredis');

const OTP_KEY_PREFIX = 'otp:';
const REPLAY_KEY_PREFIX = 'replay:';

function parseReplicationInfo(infoText) {
  const result = {
    role: 'unknown',
    connectedSlaves: 0,
    masterLinkStatus: null,
    masterHost: null,
    masterPort: null,
    replOffset: null,
  };

  if (typeof infoText !== 'string') return result;

  for (const rawLine of infoText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sepIdx = line.indexOf(':');
    if (sepIdx === -1) continue;

    const key = line.slice(0, sepIdx).trim();
    const val = line.slice(sepIdx + 1).trim();

    if (key === 'role') result.role = val;
    else if (key === 'connected_slaves') result.connectedSlaves = Number.parseInt(val, 10) || 0;
    else if (key === 'master_link_status') result.masterLinkStatus = val;
    else if (key === 'master_host') result.masterHost = val;
    else if (key === 'master_port') result.masterPort = Number.parseInt(val, 10) || null;
    else if (key === 'master_repl_offset' || key === 'slave_repl_offset') {
      const parsed = Number.parseInt(val, 10);
      if (Number.isFinite(parsed)) result.replOffset = parsed;
    }
  }

  return result;
}

function isFailoverTriggerError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  const code = String(err.code || '');
  return (
    /READONLY/i.test(msg) ||
    /Connection is closed/i.test(msg) ||
    /Stream isn't writeable/i.test(msg) ||
    /Reached the max retries per request/i.test(msg) ||
    /connect ETIMEDOUT/i.test(msg) ||
    /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(`${code} ${msg}`)
  );
}

function defaultCreateRedisClient(redisUrl, { isPrimaryRemote = false } = {}) {
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: isPrimaryRemote ? 1 : 2,
    enableReadyCheck: true,
    enableOfflineQueue: !isPrimaryRemote,
    connectTimeout: isPrimaryRemote ? 1500 : 3000,
    retryStrategy(times) {
      return Math.min(times * 100, 2000);
    },
  });

  // Prevent unhandled EventEmitter errors from crashing the process during regional outages
  client.on('error', () => {});
  return client;
}

/**
 * In-memory TTL store used strictly when CACHE_DRIVER=memory (local unit/smoke
 * testing without a live Redis daemon). Mirrors Redis EX / NX / GETDEL behavior.
 */
class MemoryCacheStore {
  constructor() {
    this.store = new Map();
  }

  _purgeIfExpired(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async setWithTtl(key, value, ttlSec) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSec * 1000,
    });
  }

  async setNxWithTtl(key, value, ttlSec) {
    this._purgeIfExpired(key);
    if (this.store.has(key)) {
      return false;
    }
    await this.setWithTtl(key, value, ttlSec);
    return true;
  }

  async getAndDelete(key) {
    const entry = this._purgeIfExpired(key);
    if (!entry) return null;
    this.store.delete(key);
    return entry.value;
  }

  async ping() {
    return 'PONG';
  }

  async getReplicationStatus() {
    return {
      mode: 'memory',
      role: 'standalone',
      promoted: false,
    };
  }

  async close() {
    this.store.clear();
  }
}

/**
 * Phase 3 Dual-Region Redis store:
 * - Connects to local regional Redis for health/replication telemetry and local reads.
 * - Routes state-mutating operations (OTP generate/consume, replay lock) to the
 *   Primary Redis when configured in a cross-region Primary -> Replica topology.
 * - Automatically promotes the local replica via `REPLICAOF NO ONE` if the primary
 *   becomes unreachable during a full regional outage.
 */
class RedisCacheStore {
  constructor(options) {
    const normalized =
      typeof options === 'string'
        ? { redisUrl: options }
        : options || {};

    const createClient = normalized.createClient || defaultCreateRedisClient;
    const localUrl = normalized.redisUrl;
    const primaryUrl = normalized.redisPrimaryUrl;

    this.autoPromote = normalized.autoPromote !== false;
    this.waitReplicas = Number.isFinite(normalized.waitReplicas) ? normalized.waitReplicas : 0;
    this.waitTimeoutMs = Number.isFinite(normalized.waitTimeoutMs) ? normalized.waitTimeoutMs : 50;

    this.localClient = createClient(localUrl, { isPrimaryRemote: false });
    this.isDualRegion = Boolean(primaryUrl && primaryUrl !== localUrl);
    this.primaryClient = this.isDualRegion
      ? createClient(primaryUrl, { isPrimaryRemote: true })
      : this.localClient;

    this.promoted = false;
    this._promotingPromise = null;
  }

  _activeWriteClient() {
    return this.promoted ? this.localClient : this.primaryClient;
  }

  async _promoteLocalReplica() {
    if (this.promoted) return;
    if (!this._promotingPromise) {
      this._promotingPromise = (async () => {
        try {
          console.warn(
            '[REDIS FAILOVER] Primary Redis unreachable; promoting local regional replica via REPLICAOF NO ONE'
          );
          await this.localClient.call('REPLICAOF', 'NO', 'ONE');
          this.promoted = true;
        } finally {
          this._promotingPromise = null;
        }
      })();
    }
    return this._promotingPromise;
  }

  async _runWrite(operationFn) {
    try {
      return await operationFn(this._activeWriteClient());
    } catch (err) {
      const canPromoteFromDualRegion =
        this.isDualRegion && !this.promoted && this.autoPromote && isFailoverTriggerError(err);
      const canPromoteReadonlyLocal =
        !this.isDualRegion && this.autoPromote && /READONLY/i.test(String(err.message || ''));

      if (canPromoteFromDualRegion || canPromoteReadonlyLocal) {
        await this._promoteLocalReplica();
        return operationFn(this.localClient);
      }
      throw err;
    }
  }

  async setWithTtl(key, value, ttlSec) {
    await this._runWrite(async (client) => {
      await client.set(key, value, 'EX', ttlSec);
      if (this.waitReplicas > 0 && !this.promoted) {
        await client.call('WAIT', this.waitReplicas, this.waitTimeoutMs);
      }
    });
  }

  async setNxWithTtl(key, value, ttlSec) {
    return this._runWrite(async (client) => {
      const res = await client.set(key, value, 'EX', ttlSec, 'NX');
      return res === 'OK';
    });
  }

  async getAndDelete(key) {
    return this._runWrite(async (client) => client.call('GETDEL', key));
  }

  async ping() {
    return this.localClient.ping();
  }

  async getReplicationStatus() {
    const infoText = await this.localClient.info('replication');
    return {
      mode: this.isDualRegion ? 'dual-region' : 'single-region',
      promoted: this.promoted,
      ...parseReplicationInfo(infoText),
    };
  }

  async close() {
    const clients =
      this.primaryClient !== this.localClient
        ? [this.localClient, this.primaryClient]
        : [this.localClient];

    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.quit();
        } catch {
          if (typeof client.disconnect === 'function') {
            client.disconnect();
          }
        }
      })
    );
  }
}

class CacheService {
  constructor(store, driverName) {
    this.store = store;
    this.driverName = driverName;
  }

  async saveOtp(txnId, uidHash, otpHash, ttlSec) {
    const payload = JSON.stringify({ uidHash, otpHash });
    await this.store.setWithTtl(`${OTP_KEY_PREFIX}${txnId}`, payload, ttlSec);
  }

  /**
   * Atomically fetches and deletes the OTP record to enforce single-use semantics
   * and prevent concurrent double-spend/race conditions.
   */
  async consumeOtp(txnId) {
    const raw = await this.store.getAndDelete(`${OTP_KEY_PREFIX}${txnId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  /**
   * Attempts to record an HMAC signature hash for `ttlSec`.
   * Returns true if newly locked, false if already seen (replay attack).
   */
  async acquireReplayLock(signatureHash, ttlSec) {
    return this.store.setNxWithTtl(`${REPLAY_KEY_PREFIX}${signatureHash}`, '1', ttlSec);
  }

  async ping() {
    return this.store.ping();
  }

  async getReplicationStatus() {
    if (typeof this.store.getReplicationStatus === 'function') {
      return this.store.getReplicationStatus();
    }
    return { mode: this.driverName, role: 'unknown', promoted: false };
  }

  async close() {
    return this.store.close();
  }
}

function createCacheService(config) {
  if (config.cacheDriver === 'memory') {
    return new CacheService(new MemoryCacheStore(), 'memory');
  }
  return new CacheService(
    new RedisCacheStore({
      redisUrl: config.redisUrl,
      redisPrimaryUrl: config.redisPrimaryUrl,
      autoPromote: config.redisAutoPromote,
      waitReplicas: config.redisWaitReplicas,
      waitTimeoutMs: config.redisWaitTimeoutMs,
    }),
    'redis'
  );
}

module.exports = {
  CacheService,
  MemoryCacheStore,
  RedisCacheStore,
  parseReplicationInfo,
  createCacheService,
};
