const os = require('os');
const crypto = require('crypto');

const DEFAULT_DEV_HMAC = 'aadhaar-prototype-aua-hmac-secret-2026';
const DEFAULT_DEV_AES_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseAesKey(hexKey) {
  const normalized = (hexKey || DEFAULT_DEV_AES_HEX).trim();
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) {
    return Buffer.from(normalized, 'hex');
  }
  // Derive a 256-bit key if a passphrase was supplied instead of 64 hex chars
  return crypto.createHash('sha256').update(normalized).digest();
}

function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const region = (env.REGION || 'mumbai').trim();

  return {
    port: parsePositiveInt(env.PORT, 3000),
    region,
    instanceId: (env.INSTANCE_ID || `${region}-${os.hostname()}`).trim(),
    cacheDriver: (env.CACHE_DRIVER || 'redis').trim().toLowerCase(),
    redisUrl: (env.REDIS_URL || 'redis://127.0.0.1:6379').trim(),
    redisPrimaryUrl: (env.REDIS_PRIMARY_URL || '').trim(),
    redisAutoPromote: env.REDIS_AUTO_PROMOTE !== 'false',
    redisWaitReplicas: parseNonNegativeInt(env.REDIS_WAIT_REPLICAS, 0),
    redisWaitTimeoutMs: parsePositiveInt(env.REDIS_WAIT_TIMEOUT_MS, 50),
    hmacSecret: env.HMAC_SECRET || DEFAULT_DEV_HMAC,
    aesKeyBuffer: parseAesKey(env.AES_KEY),
    requireHmac: env.REQUIRE_HMAC !== 'false',
    hmacWindowSec: parsePositiveInt(env.HMAC_WINDOW_SEC, 60),
    otpTtlSec: parsePositiveInt(env.OTP_TTL_SEC, 300),
    replayTtlSec: parsePositiveInt(env.REPLAY_TTL_SEC, 60),
    demoReturnOtp: env.DEMO_RETURN_OTP === 'true',
    logMockSms: env.LOG_MOCK_SMS !== 'false',
  };
}

module.exports = {
  loadConfig,
};
