import http from 'k6/http';
import { check } from 'k6';
import { generateVerhoeffUid, buildSignedPost } from './lib/aadhaar.js';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1').replace(/\/+$/, '');
const HMAC_SECRET = __ENV.HMAC_SECRET || 'aadhaar-prototype-aua-hmac-secret-2026';

// T1: Baseline Latency — 1 replica, 10 VUs, constant load for 60s
export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '60s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(50)<20', 'p(99)<50'],
  },
};

export default function () {
  const uid = generateVerhoeffUid(__VU, __ITER);
  const nonce = `${__VU}-${__ITER}-${Date.now()}`;

  const gen = buildSignedPost(HMAC_SECRET, { uid, nonce });
  const genRes = http.post(`${BASE_URL}/auth/otp/generate`, gen.rawBody, {
    headers: gen.headers,
  });

  const genOk = check(genRes, {
    'T1 generate 200': (r) => r.status === 200,
    'T1 has demoOtp': (r) => Boolean(r.json('demoOtp')),
  });
  if (!genOk) return;

  const verify = buildSignedPost(HMAC_SECRET, {
    uid,
    txnId: genRes.json('txnId'),
    otp: genRes.json('demoOtp'),
    nonce: `${nonce}-v`,
  });
  const verifyRes = http.post(`${BASE_URL}/auth/verify`, verify.rawBody, {
    headers: verify.headers,
  });

  check(verifyRes, {
    'T1 verify 200': (r) => r.status === 200,
    'T1 authStatus Y': (r) => r.json('authStatus') === 'Y',
  });
}

