import http from 'k6/http';
import { check } from 'k6';
import { generateVerhoeffUid, buildSignedPost } from './lib/aadhaar.js';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1').replace(/\/+$/, '');
const HMAC_SECRET = __ENV.HMAC_SECRET || 'aadhaar-prototype-aua-hmac-secret-2026';

// T6: Replay Attack Filter — submit identical signed HMAC request twice within 60s
export const options = {
  vus: 1,
  iterations: 5,
};

export default function () {
  const uid = generateVerhoeffUid(__VU, __ITER + 100);
  const signed = buildSignedPost(HMAC_SECRET, { uid, nonce: `t6-${__ITER}-${Date.now()}` });

  const first = http.post(`${BASE_URL}/auth/otp/generate`, signed.rawBody, {
    headers: signed.headers,
  });
  check(first, { 'T6 first request 200': (r) => r.status === 200 });

  // Exact replay using identical headers and payload
  const replay = http.post(`${BASE_URL}/auth/otp/generate`, signed.rawBody, {
    headers: signed.headers,
  });
  check(replay, {
    'T6 replay returns 403': (r) => r.status === 403,
    'T6 error is REPLAY_DETECTED': (r) => r.json('error') === 'REPLAY_DETECTED',
  });
}

