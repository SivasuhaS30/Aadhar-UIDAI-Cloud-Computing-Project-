const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createCacheService } = require('../src/services/cacheService');
const { createAuditLogger } = require('../src/services/auditLogger');
const { createApp } = require('../src/app');
const { isValidAadhaarUid, appendVerhoeffDigit } = require('../src/utils/verhoeff');
const { computeHmac, encryptAesGcm, decryptAesGcm } = require('../src/utils/crypto');

async function startTestServer(envOverrides = {}) {
  const config = loadConfig({
    CACHE_DRIVER: 'memory',
    REGION: 'mumbai',
    DEMO_RETURN_OTP: 'true',
    LOG_MOCK_SMS: 'false',
    ...envOverrides,
  });
  const cacheService = createCacheService(config);
  const auditLogger = createAuditLogger({ enabled: false });
  const app = createApp({ config, cacheService, auditLogger });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    config,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await cacheService.close();
    },
  };
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

test('Verhoeff validation detects single-digit and transposition errors', () => {
  const validUid = appendVerhoeffDigit('99991111222');
  assert.equal(validUid.length, 12);
  assert.equal(isValidAadhaarUid(validUid), true);

  // Flip one digit
  const flipped = `${validUid.slice(0, 5)}${(Number(validUid[5]) + 1) % 10}${validUid.slice(6)}`;
  assert.equal(isValidAadhaarUid(flipped), false);

  // Adjacent transposition (swap index 3 '9' and index 4 '1')
  const swapped = `${validUid.slice(0, 3)}${validUid[4]}${validUid[3]}${validUid.slice(5)}`;
  assert.equal(isValidAadhaarUid(swapped), false);

  assert.equal(isValidAadhaarUid('12345'), false);
  assert.equal(isValidAadhaarUid('99991111222a'), false);
});

test('AES-256-GCM uses unique 96-bit random IVs and decrypts cleanly', () => {
  const config = loadConfig();
  const payload = { authStatus: 'Y', txnId: 'tx-123' };

  const enc1 = encryptAesGcm(config.aesKeyBuffer, payload);
  const enc2 = encryptAesGcm(config.aesKeyBuffer, payload);

  assert.equal(enc1.iv.length, 24); // 12 bytes = 96 bits = 24 hex chars
  assert.notEqual(enc1.iv, enc2.iv);
  assert.deepEqual(decryptAesGcm(config.aesKeyBuffer, enc1), payload);
});

test('GET /health returns UP status with region metadata', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'UP');
    assert.equal(body.region, 'mumbai');
    assert.equal(body.redis, 'connected');
  } finally {
    await ctx.close();
  }
});

test('GET / serves JSON for API clients and live HTML dashboard for browsers', async () => {
  const ctx = await startTestServer({ REGION: 'ap-south-1a' });
  try {
    const jsonRes = await fetch(`${ctx.baseUrl}/`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(jsonRes.status, 200);
    const jsonBody = await jsonRes.json();
    assert.equal(jsonBody.region, 'ap-south-1a');
    assert.equal(jsonBody.status, 'UP');

    const htmlRes = await fetch(`${ctx.baseUrl}/`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get('content-type') || '', /text\/html/);
    const html = await htmlRes.text();
    assert.match(html, /Aadhaar 1:1 Real-Time Authentication Service/);

    const dashRes = await fetch(`${ctx.baseUrl}/dashboard`);
    assert.equal(dashRes.status, 200);
    assert.match(dashRes.headers.get('content-type') || '', /text\/html/);
  } finally {
    await ctx.close();
  }
});

test('OTP generate -> verify happy path, AES assertion decrypt, and single-use deletion', async () => {
  const ctx = await startTestServer();
  const validUid = appendVerhoeffDigit('99991111222');

  try {
    const genReq = buildSignedRequest(ctx.config.hmacSecret, { uid: validUid });
    const genRes = await fetch(`${ctx.baseUrl}/auth/otp/generate`, {
      method: 'POST',
      headers: genReq.headers,
      body: genReq.rawBody,
    });
    assert.equal(genRes.status, 200);
    const genBody = await genRes.json();
    assert.equal(genBody.status, 'OTP_SENT');
    assert.match(genBody.demoOtp, /^\d{6}$/);

    const verifyReq = buildSignedRequest(ctx.config.hmacSecret, {
      uid: validUid,
      txnId: genBody.txnId,
      otp: genBody.demoOtp,
    });
    const verifyRes = await fetch(`${ctx.baseUrl}/auth/verify`, {
      method: 'POST',
      headers: verifyReq.headers,
      body: verifyReq.rawBody,
    });
    assert.equal(verifyRes.status, 200);
    const verifyBody = await verifyRes.json();
    assert.equal(verifyBody.authStatus, 'Y');
    assert.equal(verifyBody.txnId, genBody.txnId);

    const decrypted = decryptAesGcm(ctx.config.aesKeyBuffer, verifyBody.encryptedAssertion);
    assert.equal(decrypted.authStatus, 'Y');
    assert.equal(decrypted.txnId, genBody.txnId);

    // Reusing the same OTP with a fresh HMAC signature (distinct timestamp) must fail (single-use)
    const reuseReq = buildSignedRequest(
      ctx.config.hmacSecret,
      {
        uid: validUid,
        txnId: genBody.txnId,
        otp: genBody.demoOtp,
      },
      Math.floor(Date.now() / 1000) + 1
    );
    const reuseRes = await fetch(`${ctx.baseUrl}/auth/verify`, {
      method: 'POST',
      headers: reuseReq.headers,
      body: reuseReq.rawBody,
    });
    assert.equal(reuseRes.status, 400);
    const reuseBody = await reuseRes.json();
    assert.equal(reuseBody.error, 'OTP_EXPIRED');
  } finally {
    await ctx.close();
  }
});

test('Replay attack with identical HMAC signature returns 403 REPLAY_DETECTED (T6)', async () => {
  const ctx = await startTestServer();
  const validUid = appendVerhoeffDigit('99991111222');

  try {
    const req = buildSignedRequest(ctx.config.hmacSecret, { uid: validUid });

    const first = await fetch(`${ctx.baseUrl}/auth/otp/generate`, {
      method: 'POST',
      headers: req.headers,
      body: req.rawBody,
    });
    assert.equal(first.status, 200);

    const replay = await fetch(`${ctx.baseUrl}/auth/otp/generate`, {
      method: 'POST',
      headers: req.headers,
      body: req.rawBody,
    });
    assert.equal(replay.status, 403);
    const replayBody = await replay.json();
    assert.equal(replayBody.error, 'REPLAY_DETECTED');
  } finally {
    await ctx.close();
  }
});

test('Invalid UID, bad HMAC signature, stale timestamp, and wrong OTP are rejected', async () => {
  const ctx = await startTestServer();
  const validUid = appendVerhoeffDigit('99991111222');

  try {
    // 1. Invalid UID checksum
    const badUidReq = buildSignedRequest(ctx.config.hmacSecret, { uid: '123456789012' });
    const badUidRes = await fetch(`${ctx.baseUrl}/auth/otp/generate`, {
      method: 'POST',
      headers: badUidReq.headers,
      body: badUidReq.rawBody,
    });
    assert.equal(badUidRes.status, 400);

    // 2. Bad HMAC signature
    const badSigRes = await fetch(`${ctx.baseUrl}/auth/otp/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-signature': '00'.repeat(32),
      },
      body: JSON.stringify({ uid: validUid }),
    });
    assert.equal(badSigRes.status, 401);

    // 3. Stale timestamp
    const staleTs = Math.floor(Date.now() / 1000) - 300;
    const staleReq = buildSignedRequest(ctx.config.hmacSecret, { uid: validUid }, staleTs);
    const staleRes = await fetch(`${ctx.baseUrl}/auth/otp/generate`, {
      method: 'POST',
      headers: staleReq.headers,
      body: staleReq.rawBody,
    });
    assert.equal(staleRes.status, 401);

    // 4. Wrong OTP produces signed authStatus: N
    const genReq = buildSignedRequest(ctx.config.hmacSecret, { uid: validUid });
    const genBody = await (await fetch(`${ctx.baseUrl}/auth/otp/generate`, {
      method: 'POST',
      headers: genReq.headers,
      body: genReq.rawBody,
    })).json();

    const wrongOtp = genBody.demoOtp === '000000' ? '111111' : '000000';
    const wrongReq = buildSignedRequest(ctx.config.hmacSecret, {
      uid: validUid,
      txnId: genBody.txnId,
      otp: wrongOtp,
    });
    const wrongRes = await fetch(`${ctx.baseUrl}/auth/verify`, {
      method: 'POST',
      headers: wrongReq.headers,
      body: wrongReq.rawBody,
    });
    assert.equal(wrongRes.status, 401);
    const wrongBody = await wrongRes.json();
    assert.equal(wrongBody.authStatus, 'N');
    assert.equal(wrongBody.error, 'INVALID_OTP');
  } finally {
    await ctx.close();
  }
});

test('DEMO_RETURN_OTP=false omits demoOtp and TTL expiry triggers 400 OTP_EXPIRED (T5)', async () => {
  const ctx = await startTestServer({ DEMO_RETURN_OTP: 'false', OTP_TTL_SEC: '1' });
  const validUid = appendVerhoeffDigit('99991111222');

  try {
    const genReq = buildSignedRequest(ctx.config.hmacSecret, { uid: validUid });
    const genRes = await fetch(`${ctx.baseUrl}/auth/otp/generate`, {
      method: 'POST',
      headers: genReq.headers,
      body: genReq.rawBody,
    });
    assert.equal(genRes.status, 200);
    const genBody = await genRes.json();
    assert.equal(genBody.demoOtp, undefined);

    // Wait past 1s TTL
    await new Promise((r) => setTimeout(r, 1100));

    const verifyReq = buildSignedRequest(ctx.config.hmacSecret, {
      uid: validUid,
      txnId: genBody.txnId,
      otp: '123456',
    });
    const verifyRes = await fetch(`${ctx.baseUrl}/auth/verify`, {
      method: 'POST',
      headers: verifyReq.headers,
      body: verifyReq.rawBody,
    });
    assert.equal(verifyRes.status, 400);
    const verifyBody = await verifyRes.json();
    assert.equal(verifyBody.error, 'OTP_EXPIRED');
  } finally {
    await ctx.close();
  }
});
