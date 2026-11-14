import http from 'k6/http';
import { check } from 'k6';
import { generateVerhoeffUid, buildSignedPost } from './lib/aadhaar.js';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1').replace(/\/+$/, '');
const HMAC_SECRET = __ENV.HMAC_SECRET || 'aadhaar-prototype-aua-hmac-secret-2026';

// T3: Peak Load Saturation — ramp 10 to 500 VUs over 3 minutes
export const options = {
  stages: [
    { duration: '1m', target: 100 },
    { duration: '1m', target: 300 },
    { duration: '1m', target: 500 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const uid = generateVerhoeffUid(__VU, __ITER);
  const nonce = `${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 8)}`;

  const gen = buildSignedPost(HMAC_SECRET, { uid, nonce });
  const genRes = http.post(`${BASE_URL}/auth/otp/generate`, gen.rawBody, {
    headers: gen.headers,
  });
  if (!check(genRes, { 'T3 generate 200': (r) => r.status === 200 })) return;

  const verify = buildSignedPost(HMAC_SECRET, {
    uid,
    txnId: genRes.json('txnId'),
    otp: genRes.json('demoOtp'),
    nonce: `${nonce}-v`,
  });
  const verifyRes = http.post(`${BASE_URL}/auth/verify`, verify.rawBody, {
    headers: verify.headers,
  });
  check(verifyRes, { 'T3 verify 200': (r) => r.status === 200 });
}

