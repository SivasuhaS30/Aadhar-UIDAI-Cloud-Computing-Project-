const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { isValidAadhaarUid, maskUid } = require('../utils/verhoeff');

const DASHBOARD_HTML_PATH = path.resolve(__dirname, '../public/index.html');
const {
  generateOtp,
  sha256Hex,
  computeHmac,
  safeEqualHex,
  encryptAesGcm,
} = require('../utils/crypto');

function buildSignedAssertion({ authStatus, txnId, config, error }) {
  const assertion = {
    authStatus,
    txnId,
    timestamp: new Date().toISOString(),
    region: config.region,
    instanceId: config.instanceId,
  };

  const signature = computeHmac(config.hmacSecret, JSON.stringify(assertion));
  const encryptedAssertion = encryptAesGcm(config.aesKeyBuffer, assertion);

  return {
    ...assertion,
    ...(error ? { error } : {}),
    signature,
    encryptedAssertion,
  };
}

function createAuthRouter({ config, cacheService, auditLogger, hmacAuth }) {
  const router = express.Router();

  router.get('/dashboard', (req, res) => {
    return res.sendFile(DASHBOARD_HTML_PATH);
  });

  router.get('/', (req, res) => {
    if (req.accepts(['json', 'html']) === 'html') {
      return res.sendFile(DASHBOARD_HTML_PATH);
    }
    return res.status(200).json({
      service: 'aadhaar-1to1-auth-microservice',
      status: 'UP',
      region: config.region,
      instanceId: config.instanceId,
      endpoints: ['GET /', 'GET /dashboard', 'GET /health', 'POST /auth/otp/generate', 'POST /auth/verify'],
    });
  });

  router.get('/health', async (req, res) => {
    try {
      const pong = await cacheService.ping();
      let replication = null;
      try {
        replication = await cacheService.getReplicationStatus();
      } catch {
        replication = { mode: cacheService.driverName, role: 'unknown' };
      }

      return res.status(200).json({
        status: 'UP',
        region: config.region,
        instanceId: config.instanceId,
        cacheDriver: cacheService.driverName,
        redis: pong === 'PONG' ? 'connected' : pong,
        replication,
        uptimeSec: Math.floor(process.uptime()),
      });
    } catch (err) {
      return res.status(503).json({
        status: 'DEGRADED',
        region: config.region,
        instanceId: config.instanceId,
        redis: 'disconnected',
        error: err.message,
      });
    }
  });

  router.post('/auth/otp/generate', hmacAuth, async (req, res, next) => {
    try {
      const { uid } = req.body || {};

      if (!isValidAadhaarUid(uid)) {
        return res.status(400).json({
          error: 'INVALID_UID',
          message: 'uid must be a valid 12-digit Aadhaar number passing Verhoeff checksum',
        });
      }

      const txnId = crypto.randomUUID();
      const otp = generateOtp();
      const maskedUid = maskUid(uid);

      await cacheService.saveOtp(
        txnId,
        sha256Hex(uid),
        sha256Hex(otp),
        config.otpTtlSec
      );

      if (config.logMockSms) {
        console.log(`[MOCK SMS] region=${config.region} txnId=${txnId} uid=${maskedUid} otp=${otp}`);
      }

      auditLogger.logEvent({
        event: 'OTP_GENERATED',
        txnId,
        maskedUid,
        region: config.region,
        instanceId: config.instanceId,
      });

      const responseBody = {
        txnId,
        status: 'OTP_SENT',
        expiresIn: config.otpTtlSec,
        region: config.region,
        instanceId: config.instanceId,
      };

      if (config.demoReturnOtp) {
        responseBody.demoOtp = otp;
      }

      return res.status(200).json(responseBody);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/auth/verify', hmacAuth, async (req, res, next) => {
    try {
      const { uid, txnId, otp } = req.body || {};

      if (!isValidAadhaarUid(uid)) {
        return res.status(400).json({
          error: 'INVALID_UID',
          message: 'uid must be a valid 12-digit Aadhaar number passing Verhoeff checksum',
        });
      }

      if (typeof txnId !== 'string' || !txnId.trim() || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'txnId and 6-digit numeric otp string are required',
        });
      }

      const cachedRecord = await cacheService.consumeOtp(txnId.trim());
      if (!cachedRecord) {
        auditLogger.logEvent({
          event: 'AUTH_VERIFY_FAILED',
          reason: 'OTP_EXPIRED',
          txnId,
          maskedUid: maskUid(uid),
          region: config.region,
        });
        return res.status(400).json({
          error: 'OTP_EXPIRED',
          message: 'OTP expired, already used, or unknown txnId',
        });
      }

      const uidMatches = safeEqualHex(sha256Hex(uid), cachedRecord.uidHash);
      const otpMatches = safeEqualHex(sha256Hex(otp), cachedRecord.otpHash);

      if (!uidMatches || !otpMatches) {
        const failureCode = !uidMatches ? 'UID_MISMATCH' : 'INVALID_OTP';
        auditLogger.logEvent({
          event: 'AUTH_VERIFY_FAILED',
          reason: failureCode,
          txnId,
          maskedUid: maskUid(uid),
          region: config.region,
        });
        return res.status(401).json(
          buildSignedAssertion({
            authStatus: 'N',
            txnId,
            config,
            error: failureCode,
          })
        );
      }

      auditLogger.logEvent({
        event: 'AUTH_VERIFY_SUCCESS',
        txnId,
        maskedUid: maskUid(uid),
        region: config.region,
        instanceId: config.instanceId,
      });

      return res.status(200).json(
        buildSignedAssertion({
          authStatus: 'Y',
          txnId,
          config,
        })
      );
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = {
  createAuthRouter,
};
