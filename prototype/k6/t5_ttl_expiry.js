import http from 'k6/http';
import { check, sleep } from 'k6';
import { generateVerhoeffUid, buildSignedPost } from './lib/aadhaar.js';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1').replace(/\/+$/, '');
const HMAC_SECRET = __ENV.HMAC_SECRET || 'aadhaar-prototype-aua-hmac-secret-2026';
const WAIT_SEC = Number(__ENV.TTL_WAIT_SEC || 301);

// T5: OTP TTL Auto-Expiry — generate OTP, sleep past TTL (default 301s), verify 400 OTP_EXPIRED
export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const uid = generateVerhoeffUid(1, 1);
  const gen = buildSignedPost(HMAC_SECRET, { uid, nonce: `t5-${Date.now()}` });
  const genRes = http.post(`${BASE_URL}/auth/otp/generate`, gen.rawBody, {
    headers: gen.headers,
  });
  check(genRes, { 'T5 generate 200': (r) => r.status === 200 });

  const txnId = genRes.json('txnId');
  const otp = genRes.json('demoOtp') || '123456';

  sleep(WAIT_SEC);

  const verify = buildSignedPost(HMAC_SECRET, {
    uid,
    txnId,
    otp,
    nonce: `t5-verify-${Date.now()}`,
  });
  const verifyRes = http.post(`${BASE_URL}/auth/verify`, verify.rawBody, {
    headers: verify.headers,
  });

  check(verifyRes, {
    'T5 expired returns 400': (r) => r.status === 400,
    'T5 error is OTP_EXPIRED': (r) => r.json('error') === 'OTP_EXPIRED',
  });
}

