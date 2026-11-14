import http from 'k6/http';
import { check } from 'k6';
import { generateVerhoeffUid, buildSignedPost } from './lib/aadhaar.js';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1').replace(/\/+$/, '');
const HMAC_SECRET = __ENV.HMAC_SECRET || 'aadhaar-prototype-aua-hmac-secret-2026';

// T2: Horizontal Scaling — constant 200 RPS across 1 vs 3 replicas
export const options = {
  scenarios: {
    constant_rps: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.TARGET_RPS || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 60),
      maxVUs: Number(__ENV.MAX_VUS || 250),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(99)<200'],
  },
};

export default function () {
  const uid = generateVerhoeffUid(__VU, __ITER);
  const nonce = `${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 8)}`;

  const gen = buildSignedPost(HMAC_SECRET, { uid, nonce });
  const genRes = http.post(`${BASE_URL}/auth/otp/generate`, gen.rawBody, {
    headers: gen.headers,
  });
  if (!check(genRes, { 'T2 generate 200': (r) => r.status === 200 })) return;

  const verify = buildSignedPost(HMAC_SECRET, {
    uid,
    txnId: genRes.json('txnId'),
    otp: genRes.json('demoOtp'),
    nonce: `${nonce}-v`,
  });
  const verifyRes = http.post(`${BASE_URL}/auth/verify`, verify.rawBody, {
    headers: verify.headers,
  });
  check(verifyRes, { 'T2 verify 200': (r) => r.status === 200 });
}

