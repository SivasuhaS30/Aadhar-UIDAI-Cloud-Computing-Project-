const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  try {
    // Load dotenv from auth-service dependencies without requiring root node_modules
    require(path.resolve(__dirname, '../auth-service/node_modules/dotenv')).config({ path: envPath });
  } catch {
    // Ignore if dependencies are not installed yet
  }
}

const { loadConfig } = require('../auth-service/src/config');
const { appendVerhoeffDigit } = require('../auth-service/src/utils/verhoeff');
const { computeHmac, decryptAesGcm } = require('../auth-service/src/utils/crypto');

const config = loadConfig();
const baseUrl = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const testUid = process.argv[3] || appendVerhoeffDigit('99991111222');

async function postSigned(endpoint, payload, overrideHeaders = null) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeHmac(config.hmacSecret, `${timestamp}.${rawBody}`);

  const headers = overrideHeaders || {
    'content-type': 'application/json',
    'x-timestamp': timestamp,
    'x-signature': signature,
  };

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  const data = await res.json();
  return { status: res.status, data, headers };
}

async function runSmokeTests() {
  console.log(`\n=== Aadhaar Auth Service Smoke Test (${baseUrl}) ===`);
  console.log(`Using valid Verhoeff UID: ${testUid}\n`);

  // 1. Health check (NGINX + Auth microservice)
  const nginxRes = await fetch(`${baseUrl}/nginx-health`);
  if (nginxRes.ok) {
    console.log('0) GET /nginx-health ->', nginxRes.status, await nginxRes.json());
  }

  const healthRes = await fetch(`${baseUrl}/health`);
  const healthBody = await healthRes.json();
  console.log('1) GET /health ->', healthRes.status, healthBody);
  if (healthRes.status !== 200) throw new Error('Health check failed');

  // 2. Generate OTP (and keep headers to test Replay Attack next)
  const gen = await postSigned('/auth/otp/generate', { uid: testUid });
  console.log('2) POST /auth/otp/generate ->', gen.status, gen.data);
  if (gen.status !== 200 || !gen.data.demoOtp) {
    throw new Error('OTP generate failed or DEMO_RETURN_OTP is false');
  }

  // 3. Replay attack check (T6): resend exact same signed request
  const replay = await postSigned('/auth/otp/generate', { uid: testUid }, gen.headers);
  console.log('3) Replay Attack Test ->', replay.status, replay.data);
  if (replay.status !== 403 || replay.data.error !== 'REPLAY_DETECTED') {
    throw new Error('Expected 403 REPLAY_DETECTED');
  }

  // 4. Verify OTP
  const verify = await postSigned('/auth/verify', {
    uid: testUid,
    txnId: gen.data.txnId,
    otp: gen.data.demoOtp,
  });
  console.log('4) POST /auth/verify ->', verify.status, verify.data);
  if (verify.status !== 200 || verify.data.authStatus !== 'Y') {
    throw new Error('OTP verification failed');
  }

  // 5. Decrypt AES-256-GCM assertion to prove valid response encryption
  const decrypted = decryptAesGcm(config.aesKeyBuffer, verify.data.encryptedAssertion);
  console.log('5) Decrypted AES-256-GCM Assertion ->', decrypted);

  // 6. Single-use check: wait 1s for fresh timestamp/signature, verify same txnId again
  await new Promise((r) => setTimeout(r, 1050));
  const reuse = await postSigned('/auth/verify', {
    uid: testUid,
    txnId: gen.data.txnId,
    otp: gen.data.demoOtp,
  });
  console.log('6) Single-Use Reuse Check ->', reuse.status, reuse.data);
  if (reuse.status !== 400 || reuse.data.error !== 'OTP_EXPIRED') {
    throw new Error('Expected 400 OTP_EXPIRED on OTP reuse');
  }

  console.log('\nALL SMOKE CHECKS PASSED!\n');
}

runSmokeTests().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.message);
  process.exit(1);
});
