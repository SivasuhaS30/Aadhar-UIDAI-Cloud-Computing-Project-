# Aadhaar 1:1 Auth Microservice — Verification & Test Results

> **Execution Scope Notice:** Sections 1–3 document local verification executed on **Node.js v20.20.2 (`win32 x64`)** using the in-memory store, stateful Primary $\rightarrow$ Replica Redis mock, and local failover reverse proxy (`node --test`, `run-local-verification.js`, and `run-local-chaos-sim.js`). Sections 4–6 document **live AWS Multi-AZ cloud verification** executed on **2 × AWS EC2 `t3.micro` instances (`ap-southeast-2a` & `ap-southeast-2b`) behind AWS Application Load Balancer `aadhaar-alb` (`http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com`)**, including E2E security smoke tests, live Zone A stop Chaos/Failover telemetry (`chaos-monitor.js` + Google Drive video), and real AWS Billing/Cost Explorer metrics. The Grafana `k6` scripts (`T1`–`T6`) in `prototype/k6/` are ready for optional high-VU synthetic load generation against any target URL.

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

## 4. Live AWS Multi-AZ Deployment & Functional Smoke Verification

- **Deployment Topology (`ap-southeast-2`):**
  - **Application Load Balancer:** `aadhaar-alb` (`http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/`) spanning `ap-southeast-2a` and `ap-southeast-2b`
  - **Target Group:** `aadhaar-tg` (`HTTP:80`, `/health`, healthy threshold `2`, unhealthy threshold `2`, timeout `3 s`, interval `5 s`)
  - **Zone A Primary (`ap-southeast-2a`):** `t3.micro` (`i-0e9c87fbdd47a2b02`, private IP `172.31.3.123`, `REGION=ap-southeast-2a`, Redis `master`)
  - **Zone B Replica (`ap-southeast-2b`):** `t3.micro` (`i-058e1e4be450ce52c`, private IP `172.31.41.130`, `REGION=ap-southeast-2b`, Redis `slave` replicating from `172.31.3.123:6379`)
- **Live Browser Load-Balance Probe:** `12 / 0` (`12 OK`, `0 errors`) — `6 hits` routed to `ap-southeast-2a` (`master`) and `6 hits` routed to `ap-southeast-2b` (`slave / link:up`), `276–279 ms` WAN RTT per request from India to AWS Sydney.
- **Live E2E Security Smoke Test (`node prototype/scripts/test-client.js`):** **`ALL SMOKE CHECKS PASSED!` (`6/6`)**
  1. `GET /health -> 200` (`ap-southeast-2b`, Redis `connected`, `role: slave`, `masterLinkStatus: up`)
  2. `POST /auth/otp/generate -> 200` (`ap-southeast-2a`, `OTP_SENT`, `expiresIn: 300`)
  3. `Replay Attack Test -> 403 REPLAY_DETECTED` (HMAC + nonce window enforcement)
  4. `POST /auth/verify -> 200` (`authStatus: 'Y'`, signed HMAC + AES-256-GCM encrypted assertion)
  5. `Decrypted AES-256-GCM Assertion -> authStatus: 'Y'`
  6. `Single-Use Reuse Check -> 400 OTP_EXPIRED`

---

## 5. Live AWS Multi-AZ Chaos / Failover Experiment (`chaos-monitor.js`) & Video

- **Chaos Failover Video Recording:** [Google Drive Recording — Live Zone A Shutdown & Zone B Auto-Promotion](https://drive.google.com/file/d/1knZ0NuT9ByiJ9Jv9SY7KTEyB0pXB5Xma/view?usp=drive_link)
- **Raw Outputs:** [`chaos-report-aws-alb-2026-11-15T16-17-44-526Z.json`](./chaos-report-aws-alb-2026-11-15T16-17-44-526Z.json) & [`chaos-timeline-aws-alb-2026-11-15T16-17-44-526Z.csv`](./chaos-timeline-aws-alb-2026-11-15T16-17-44-526Z.csv)
- **Command:** `node prototype/scripts/chaos-monitor.js --url http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com --hmac-secret <SECRET> --interval-ms 500 --duration-sec 90 --tag aws-alb`
- **Executed At:** `2026-11-15T16:17:44.524Z`
- **Summary Metrics (`58` full dual-request ticks):**
  - **Health Availability:** `54 / 58` (`93.1%`; `4` failed probes strictly inside the ALB unhealthy detection drain window)
  - **Full Signed Auth (`generate` $\rightarrow$ `verify`) Success:** `54 / 58` (`93.1%`; `4` failures during Zone A cutover)
  - **Zone Distribution:** `ap-southeast-2a: 11` (pre-outage), `ap-southeast-2b: 43` (steady-state + post-failover)
  - **Redis Auto-Promotion Observed:** `true` (`REPLICAOF NO ONE` executed automatically on Zone B at tick `#25`)
  - **Health Latency (`GET /health` from India $\rightarrow$ Sydney ALB):** `p50 = 313.11 ms`, `p95 = 316.94 ms`, `p99 = 703.90 ms`
  - **Full Auth Latency (`generate` + `verify` from India $\rightarrow$ Sydney ALB):** `p50 = 616.59 ms`, `p95 = 942.97 ms`, `p99 = 4298.07 ms` (tick `#25` failover promotion lock)

| Window / Ticks | UTC Timestamp | Observed Behavior |
| :--- | :--- | :--- |
| `#001`–`#019` | `16:16:13.702Z`–`16:16:40.202Z` | Healthy Multi-AZ round-robin between `ap-southeast-2a` (`master`) & `ap-southeast-2b` (`slave`); `auth=200 result=Y` (`~305 ms` health, `~615 ms` auth) |
| `#020` | `16:16:41.631Z` | Zone A (`aadhaar-zone-a`) stopped in AWS EC2; `health=200` on `ap-southeast-2b`, `auth=500 INTERNAL_ERROR` on draining Zone A target |
| `#021`–`#024` | `16:16:43.003Z`–`16:16:50.717Z` | ALB unhealthy threshold window (`2 × 5 s`, `~10.5 s` total convergence from `#020` to `#025`); `#021` `auth=200` on `ap-southeast-2b`, `#022`–`#024` `502` |
| `#025` | `16:16:52.163Z` | ALB stops routing to Zone A; Zone B self-promotes (`role=master [PROMOTED]`), `health=200` (`314.56 ms`), `auth=200 result=Y` (`4298.07 ms`) |
| `#026`–`#058` | `16:16:57.287Z`–`16:17:43.587Z` | `33` consecutive steady-state promoted ticks on `ap-southeast-2b` (`0` errors, `~313 ms` health, `~619 ms` auth) |

- **Post-Outage Recovery Verified:** After restarting `aadhaar-zone-a` and running `docker compose -f docker-compose.az.yml restart` on `aadhaar-zone-b`, live `GET /health` confirmed `ap-southeast-2a` (`role: "master"`, `connectedSlaves: 1`, `replOffset: 140`) and `ap-southeast-2b` (`role: "slave"`, `masterLinkStatus: "up"`, `replOffset: 140`).

---

## 6. Live AWS Billing & Synthetic Load Scripts (`k6`)

- **AWS Billing (`aadhaar-uidai-CloudComputing`, Account `511053344168`):**
  - **Spend Limit & Controls:** `Spend limit: $20.00 / month` (`Status: Within limit`, early cost controls active, UPI AutoPay enabled, `Balance Amount due: $0.00`)
  - **Available Promotional Credits:** `$120.00 USD`
  - **Observed Month-to-Date Spend:** `$0.98` | **AWS Month-End Forecast (24×7 Multi-AZ run):** `$14.26 / month`
- **Synthetic `k6` Load Suite (`prototype/k6/t1_baseline.js`–`t6_replay.js`):** Scripted and verified for syntax against [`prototype/k6/run_benchmarks.sh`](../k6/run_benchmarks.sh) for optional high-VU synthetic load testing inside VPC (`50–500 VUs`); held out of public internet saturation tests against shared institutional gateways and `t3.micro` burstable CPU credits.
