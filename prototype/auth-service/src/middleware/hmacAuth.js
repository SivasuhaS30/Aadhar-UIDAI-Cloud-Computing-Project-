const { computeHmac, safeEqualHex, sha256Hex } = require('../utils/crypto');

/**
 * Verifies AUA request authenticity (HMAC-SHA256), timestamp freshness,
 * and single-use replay protection via Redis NX lock (Test T6).
 */
function createHmacAuthMiddleware({ config, cacheService }) {
  return async function hmacAuth(req, res, next) {
    if (!config.requireHmac) {
      return next();
    }

    const timestampHeader = req.get('x-timestamp');
    const signatureHeader = req.get('x-signature');

    if (!timestampHeader || !signatureHeader) {
      return res.status(401).json({
        error: 'MISSING_AUTH_HEADERS',
        message: 'x-timestamp and x-signature headers are required',
      });
    }

    const reqTimestampSec = Number.parseInt(timestampHeader, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(reqTimestampSec) || Math.abs(nowSec - reqTimestampSec) > config.hmacWindowSec) {
      return res.status(401).json({
        error: 'STALE_TIMESTAMP',
        message: `Request timestamp outside allowed ${config.hmacWindowSec}s window`,
      });
    }

    const rawBody = req.rawBody || '';
    const canonicalPayload = `${timestampHeader}.${rawBody}`;
    const expectedSignature = computeHmac(config.hmacSecret, canonicalPayload);

    if (!safeEqualHex(signatureHeader, expectedSignature)) {
      return res.status(401).json({
        error: 'INVALID_SIGNATURE',
        message: 'HMAC-SHA256 signature verification failed',
      });
    }

    try {
      const signatureHash = sha256Hex(signatureHeader.toLowerCase());
      const acquired = await cacheService.acquireReplayLock(signatureHash, config.replayTtlSec);
      if (!acquired) {
        return res.status(403).json({
          error: 'REPLAY_DETECTED',
          message: 'Duplicate request signature detected within replay window',
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  createHmacAuthMiddleware,
};
