# Aadhaar 1:1 Auth Microservice — Verification & Test Results

> **Execution Scope Notice:** All results below were executed locally on **Node.js v20.20.2 (`win32 x64`)** using the in-memory store, stateful Primary $\rightarrow$ Replica Redis mock, and local failover reverse proxy (`node --test`, `run-local-verification.js`, and `run-local-chaos-sim.js`). Live AWS Multi-AZ EC2 + ALB chaos demonstrations and `k6` load tests (`T1`–`T6`) remain to be run once hosted on AWS.

---

## 1. Automated Unit & Integration Test Suite (`node --test`)

- **Command:** `node --test auth-service/tests/auth.test.js auth-service/tests/replication.test.js`
- **Raw Output:** [`unit-and-replication-tests.tap`](./unit-and-replication-tests.tap)
- **Summary:** **12 passed, 0 failed, 0 skipped** (total duration: `10357.81 ms`)

| # | Test Case | Scope / Requirement | Status | Duration (ms) |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Verhoeff validation detects single-digit and transposition errors | UID checksum integrity | Pass | 0.94 |
| 2 | AES-256-GCM uses unique 96-bit random IVs and decrypts cleanly | Sec. 6.4 IV-reuse fix | Pass | 3.13 |
| 3 | `GET /health` returns UP status with region metadata | Health & readiness probe | Pass | 39.85 |
| 4 | `GET /` serves JSON for API clients and live HTML dashboard for browsers | ALB / NGINX root UI | Pass | 23.42 |
| 5 | OTP generate $\rightarrow$ verify happy path, AES decrypt, single-use deletion | Core 1:1 OTP lifecycle | Pass | 453.84 |
| 6 | Replay attack with identical HMAC signature returns `403 REPLAY_DETECTED` | Scenario **T6** | Pass | 7.91 |
| 7 | Invalid UID, bad HMAC, stale timestamp, and wrong OTP are rejected | Input & HMAC zero-trust | Pass | 12.93 |
| 8 | `DEMO_RETURN_OTP=false` omits `demoOtp` & TTL expiry returns `400 OTP_EXPIRED` | Scenario **T5** (1s TTL sim) | Pass | 1115.89 |
| 9 | `parseReplicationInfo` parses primary and replica `INFO` output | Phase 3 Redis telemetry | Pass | 0.97 |
| 10 | `RedisCacheStore` invokes `WAIT` when `waitReplicas > 0` & skips post-promotion | Semi-sync replication hook | Pass | 1.29 |
| 11 | Concurrent primary failure promotes local replica exactly once | Phase 3 concurrency lock | Pass | 0.77 |
| 12 | Dual-region HTTP flow: cross-region verify, replay block, & primary outage failover | Phase 3 end-to-end failover | Pass | 525.06 |

---

## 2. Dual-Region Smoke, Failover & Loopback Concurrency Verification

- **Command:** `node scripts/run-local-verification.js`
- **Raw Output:** [`local-verification-results.json`](./local-verification-results.json)
- **Executed At:** `2026-11-14T09:06:40.439Z`

### 2.1 Functional & Failover Checks (Mumbai Primary + Hyderabad Replica Mock)
- **Region 1 (`mumbai`) `/health`:** `status: "UP"`, `role: "master"`, `connectedSlaves: 1`
- **Region 2 (`hyderabad`) `/health` (before outage):** `status: "UP"`, `mode: "dual-region"`, `role: "slave"`, `masterLinkStatus: "up"`
- **Cross-Region Verify (Generate on Mumbai $\rightarrow$ Verify on Hyderabad):** `200 OK`, `authStatus: "Y"`, AES-256-GCM decrypted `authStatus: "Y"`
- **Cross-Region Replay Attack (Reuse Mumbai HMAC on Hyderabad):** `403 Forbidden`, `error: "REPLAY_DETECTED"`
- **Primary Redis Outage Auto-Promotion:** After generating an OTP on Mumbai and taking Primary Redis offline, Hyderabad auto-promoted its local replica (`REPLICAOF NO ONE`), preserved the replicated OTP, and verified it with `200 OK` (`authStatus: "Y"`, `replication.promoted: true`, `replication.role: "master"`).

### 2.2 Loopback HTTP Concurrency Micro-Benchmark (10 Concurrent Workers)
- **Workload:** 500 signed HTTP requests (250 `POST /auth/otp/generate` + 250 `POST /auth/verify` round-trips across both Express instances)
- **Total Duration:** `0.426 s`
- **Success / Failure:** `500` succeeded / `0` failed (`0.00%` error rate)
- **Throughput:** `1174.7 req/s`
- **Latency Distribution:**
  - `min`: `3.91 ms`
  - `p50`: `7.83 ms`
  - `p95`: `11.17 ms`
  - `p99`: `19.61 ms`
  - `max`: `22.65 ms`

---

## 3. Local Multi-AZ Chaos / Failover Simulation (`chaos-monitor.js`)

- **Command:** `node scripts/run-local-chaos-sim.js`
- **Raw Outputs:** [`chaos-report-local-sim-2026-11-14T09-06-42-729Z.json`](./chaos-report-local-sim-2026-11-14T09-06-42-729Z.json) & [`chaos-timeline-local-sim-2026-11-14T09-06-42-729Z.csv`](./chaos-timeline-local-sim-2026-11-14T09-06-42-729Z.csv)
- **Executed At:** `2026-11-14T09:06:42.728Z`
- **Scenario:** Continuous probes (`GET /health` + full signed `POST /auth/otp/generate` $\rightarrow$ `POST /auth/verify`) through a round-robin failover proxy across `ap-south-1a` and `ap-south-1b`; Zone A (`ap-south-1a` compute + Primary Redis) was terminated after tick 5.
- **Outcome:**
  - **Health Availability:** `12/12` (`100%`)
  - **End-to-End Auth Success:** `12/12` (`0` failures)
  - **Zone Distribution:** `ap-south-1a: 3`, `ap-south-1b: 9`
  - **Redis Auto-Promotion Observed:** `true` (`role: slave` $\rightarrow$ `role: master [PROMOTED]` on tick 7)
  - **Latency (`p50` / `p99`):** Health `2.33 ms` / `30.10 ms`; Full Signed Auth `4.48 ms` / `21.65 ms`

---

## 4. Pending Live AWS Benchmarks & Chaos Video (After Hosting)

1. Deploy across `ap-south-1a` & `ap-south-1b` behind AWS ALB using [`DEPLOYMENT.md`](../DEPLOYMENT.md), then run the live Chaos/Failover monitor while stopping Zone A in EC2 Console:
   ```bash
   node prototype/scripts/chaos-monitor.js --url http://<ALB-DNS-NAME> --hmac-secret <SECRET> --interval-ms 500 --duration-sec 90 --tag aws-alb
   ```
2. Run the `k6` benchmark suite (`T1`–`T6`):
   ```bash
   cd prototype
   BASE_URL=http://<HOST_OR_ALB> ./k6/run_benchmarks.sh
   ```
