# Aadhaar (UIDAI) Cloud Architecture & Prototype — Project Handbook

> **Course:** IT457 – Cloud Computing | **Group:** 44  
> **Scope:** Complete conceptual + implementation reference covering (1) the national-scale UIDAI case study and (2) the multi-region 1:1 authentication microservice built in `prototype/`.

---

## 1. Big Picture: What Problem Does This Project Solve?

India needed a **foundational digital identity layer** for 1.4+ billion residents that proves two things without becoming a bloated entitlement database:
1. **Uniqueness (at enrollment):** One resident = one 12-digit Aadhaar UID (eliminating duplicate and "ghost" identities).
2. **Real-Time Presence (at authentication):** Verify *"Are you who you claim to be?"* in `<200 ms` across banks, telecoms, and welfare shops while leaking **zero personal data (PII)**.

**Why this matters in Cloud Computing:** You cannot serve both workloads with one monolithic server or database. UIDAI's core engineering insight is **strict workload bifurcation** across a sovereign private cloud built on commodity x86 Linux hardware.

---

## 2. Case Study Architecture: How UIDAI Operates at National Scale

### 2.1 Verified Scale & Outcomes (UIDAI Whitepaper, Biometrics Report & CAG Audit)
| Dimension | Metric / Finding |
| :--- | :--- |
| **Population & Volume** | >1.329B cumulative UIDs (>1.268B live); >71.94B cumulative authentications; 48.5M (audit avg) to 100M+ peak daily auths |
| **Data & Compute Scale** | >4 PB primary storage; 1.0–1.5M daily enrollment packets; ~600 trillion 1:N biometric comparisons/day |
| **Biometric Accuracy** | 10 fingerprints + 2 irises + 1 face photo (multimodal to overcome manual-labor fingerprint wear); FPIR `0.057%`, FNIR `0.035%`, B-FTE `0.14%` |
| **Cost & Socioeconomic Impact** | Enrollment cost `<$1` per resident (vs. `$5–$15` globally); 766M+ bank accounts mapped for DBT (`INR 6.21 Lakh Crore` disbursed) |
| **CAG Audit No. 24 (2021) Findings** | Highlighted governance gaps: delayed commercial billing (2016–19), unpenalized vendor SLA breaches, INR 310 Cr on Bal Aadhaar (<5 yrs without dedup), and 475,000 retroactive duplicate cancellations |

### 2.2 Why Private Sovereign Cloud (Not Public Cloud)?
- **Data Sovereignty:** National regulations prohibit hosting citizen biometric records on foreign multi-tenant public clouds.
- **Economics at Petabyte Scale:** Commodity x86 Linux clusters + open-source software eliminated proprietary mainframe/license lock-in and massive public-cloud data egress fees.

### 2.3 Workload Bifurcation: 1:N Enrollment vs. 1:1 Authentication
| Dimension | Workload A: 1:N Deduplication (Enrollment) | Workload B: 1:1 Verification (Authentication) |
| :--- | :--- | :--- |
| **Question Answered** | *"Does this person already exist anywhere in the 1.4B gallery?"* | *"Does this probe match UID `X`'s stored record?"* |
| **Execution Pattern** | Asynchronous, batch **Staged Event-Driven Architecture (SEDA)** via Mule ESB & RabbitMQ | Synchronous, stateless REST microservice |
| **SLA / Latency** | Hours to days (24–48 hr target) | Real-time sub-second (`<200 ms` avg) |
| **Key Mechanism** | 3 competing commercial ABIS engines (Morpho, L1, 3M Cogent) run in parallel via vendor-neutral APIs; consensus prevents single-vendor bias | Direct point lookup by UID key; returns only a digitally signed boolean `Yes` / `No` |

### 2.4 CIDR's 6 Functional Tiers & Active-Active Topology
UIDAI runs **two Tier-3 Active-Active Data Centers**—**PDC Hebbal (Bengaluru)** and **DRDC Manesar (Gurugram)**—linked via dual 10 Gbps links, each sized to absorb 100% of national traffic if the other fails:

1. **Layer 0 — Global Traffic Direction:** BGP Anycast & global DNS route southern traffic to Hebbal and northern traffic to Manesar.
2. **Layer 1 — Perimeter & Partner DMZ:** AUAs (banks/agencies) connect through certified ASAs over dedicated MPLS leased lines into hardware firewalls, IPS, and TLS reverse proxies.
3. **Layer 2 — Stateless Compute Tier:** Clustered Java/Node.js servers holding zero local session state so nodes scale horizontally on demand.
4. **Layer 3 — Hot In-Memory Cache (`<1 ms`):** Redis / Project Voldemort for transient OTPs, session state, and anti-replay sets.
5. **Layer 4 — Tiered Persistent Storage (Right Tool per Workload):**
   - **Sharded MySQL (`5–15 ms`):** 100-way horizontal sharding by the first 2 digits of the 12-digit UID (+ 16-way sub-sharding on the 3rd digit) for `O(1)` routing without cross-shard joins.
   - **Apache HBase (`2–8 ms`):** Columnar NoSQL store for indexed biometric feature templates.
   - **Hadoop HDFS / SATA LUNs (Batch):** Immutable cold storage for raw 3–5 MB encrypted packets using hash-bucket directories (avoiding inode exhaustion) + offsite magnetic tape backups.
6. **Layer 5 — Async Messaging:** RabbitMQ / Kafka decouple non-blocking audit logs, telemetry, and SMS dispatch from the critical auth path.
7. **Layer 6 — Cryptographic Backbone:** FIPS 140-2 Level 3 Hardware Security Modules (HSMs) keep root private keys inside tamper-resistant silicon via PKCS#11 (never in OS RAM).

### 2.5 Security Model & The AES-GCM IV Vulnerability
- **Registered Devices (L0/L1):** Biometrics are encrypted inside the scanner hardware (L1 uses a Trusted Execution Environment) using UIDAI's RSA-2048 public key + ephemeral AES-256 session keys before touching host PC memory.
- **Privacy by Design:** Relying agencies receive only `Yes`/`No` (never raw biometrics); **16-digit Virtual IDs (VIDs)** and the **Aadhaar Data Vault (ADV)** isolate raw 12-digit UIDs from partner databases.
- **Tiwari et al. Cryptographic Finding:** Legacy APIs (v2.0/v2.5) built AES-GCM Initialization Vectors (IVs) from truncated timestamps (`-DDThh:mm:ss`). Concurrent transactions within the same second reused the same `(Key, IV)` pair, breaking Galois/Counter Mode integrity and leaking plaintext XORs (`C1 ^ C2 = P1 ^ P2`). UIDAI fixed this by enforcing **cryptographically random 96-bit IVs**.

---

## 3. Our Prototype: What We Built & Why Every Piece Exists

### 3.1 Why Build the 1:1 Auth & OTP Pipeline?
Full 1:N deduplication requires proprietary COTS biometric SDKs (Morpho/L1/3M). The **1:1 synchronous authentication & OTP pipeline** is UIDAI's most latency-critical tier and lets us implement every core cloud pattern directly: stateless horizontal scaling, sub-millisecond Redis caching, cross-region replication + failover, and zero-trust cryptography.

### 3.2 Production CIDR $\rightarrow$ Prototype Mapping
| UIDAI Production Tier | Prototype Implementation | Where in `prototype/` |
| :--- | :--- | :--- |
| BGP Anycast + F5 Hardware LB | AWS Application Load Balancer (2 AZs) or NGINX 1.25 Round-Robin + Failover + `/` Live UI | [`docker-compose.az.yml`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/docker-compose.az.yml), [`nginx/nginx.conf`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/nginx/nginx.conf), [`auth-service/src/public/index.html`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/public/index.html) |
| Stateless Auth Microservices | Node.js 20 LTS / Express 4 (`region1_auth` Mumbai, `region2_auth` Hyderabad) | [`auth-service/src/app.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/app.js), [`auth-service/src/routes/authRoutes.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/routes/authRoutes.js) |
| Hot In-Memory Cache (Active-Active / Sync) | Dual Redis 7 (`redis_region1` Primary $\rightarrow$ `redis_region2` Replica) | [`docker-compose.yml`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/docker-compose.yml), [`auth-service/src/services/cacheService.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/services/cacheService.js) |
| Edge/HSM Cryptography | `HMAC-SHA256`, `AES-256-GCM` (random 96-bit IV), Verhoeff D5 | [`auth-service/src/utils/crypto.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/utils/crypto.js), [`auth-service/src/utils/verhoeff.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/utils/verhoeff.js) |
| Async Audit Queue (Kafka/RabbitMQ) | Non-blocking `setImmediate` structured JSON audit logger | [`auth-service/src/services/auditLogger.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/services/auditLogger.js) |

---

### 3.3 End-to-End Request Lifecycle (How a Transaction Flows)

```text
  Client (AUA / k6 / test-client.js)
         │  HMAC-SHA256(secret, timestamp + "." + rawBody)
         ▼
  [ NGINX Ingress (:80 / :443 TLS opt.) ]  ── GET / ──> Static Telemetry Dashboard
         │  Round-Robin + proxy_next_upstream failover
         ├───────────────────────────┐
         ▼                           ▼
  [ region1_auth (mumbai) ]   [ region2_auth (hyderabad) ]
         │                           │
         │  1. hmacAuth: verify window (±60s), timingSafeEqual sig,
         │     and atomic Redis lock `SET replay:<hash> 1 EX 60 NX`
         │  2. Verhoeff D5 checksum on 12-digit UID
         │  3. Generate: store SHA-256(uid, otp) w/ EX 300
         │     Verify: atomic `GETDEL` + AES-256-GCM signed assertion
         │  4. Audit: `setImmediate` JSON log (masked UID only)
         │                           │
         └──────────► [ redis_region1 (Primary) ] ═══ async sync ═══► [ redis_region2 (Replica) ]
                                                                             ▲
                         (If redis_region1 dies: auto `REPLICAOF NO ONE` ─────┘)
```

---

### 3.4 Key Implementation Decisions & **Why** Each Was Done

1. **Verhoeff Dihedral $D_5$ Checksum (`verhoeff.js`)**
   - **What:** Validates every incoming 12-digit `uid` (`isValidAadhaarUid`) and masks UIDs (`********1234`) before logging (`maskUid`).
   - **Why:** Real Aadhaar numbers use the Verhoeff algorithm (unlike simple mod-10 Luhn) to catch **100% of single-digit typos and adjacent transposition errors** right at the API edge before touching Redis, while masking preserves privacy in logs.

2. **Raw-Body HMAC-SHA256 & Timestamp Window (`app.js`, `hmacAuth.js`)**
   - **What:** `express.json` captures `req.rawBody` bytes; `hmacAuth` checks `x-timestamp` within `±60s` (`HMAC_WINDOW_SEC`), computes `HMAC-SHA256` over `${timestamp}.${rawBody}`, and validates via `crypto.timingSafeEqual` (`safeEqualHex`).
   - **Why:** Simulates zero-trust AUA/ASA authentication. Using raw bytes avoids JSON re-serialization mismatches, and constant-time comparison blocks timing side-channel attacks.

3. **Atomic Single-Use Replay Lock (`SET ... NX EX 60`)**
   - **What:** Every verified signature's SHA-256 hash is written to Redis with `SET replay:<hash> 1 EX 60 NX`. If the key already exists, the request immediately fails with `403 REPLAY_DETECTED` (Scenario **T6**).
   - **Why:** A 60-second clock-skew window normally lets an attacker intercept and replay an identical signed request within those 60 seconds. Redis `SET NX` closes that window atomically across all stateless API replicas.

4. **Hashed Secrets + Atomic `GETDEL` OTP Consumption (`authRoutes.js`, `cacheService.js`)**
   - **What:** `POST /auth/otp/generate` generates a 6-digit OTP using CSPRNG (`crypto.randomInt`) and stores only `SHA-256(uid)` + `SHA-256(otp)` with `EX 300` (Scenario **T5**). `POST /auth/verify` pops the record in one atomic `GETDEL` command.
   - **Why:** Storing hashes means a cache inspection never leaks raw Aadhaar numbers or active OTPs. Using `GETDEL` (instead of `GET` followed by `DEL`) prevents a race condition where two concurrent verify requests both read the same valid OTP before it is deleted, and prevents brute-force guesses on one `txnId`.

5. **Random 96-Bit IV AES-256-GCM Assertions (`crypto.js`)**
   - **What:** Verification responses include a signed `authStatus` (`"Y"` or `"N"`) plus `encryptedAssertion` encrypted with `AES-256-GCM` using `crypto.randomBytes(12)` per call.
   - **Why:** Directly implements the mitigation for the Tiwari et al. Sec. 6.4 timestamp-IV-reuse vulnerability—every response gets an independent 96-bit random IV and GCM authentication tag.

6. **Non-Blocking Audit Logging (`auditLogger.js`)**
   - **What:** Wraps audit log serialization and output inside `setImmediate(...)`.
   - **Why:** Keeps I/O off the HTTP response critical path (simulating UIDAI's Kafka/RabbitMQ async decoupling) so logging never inflates `p99` latency.

7. **Dual-Region Redis Replication + Single-Flight Auto-Promotion (`cacheService.js`, `docker-compose.yml`)**
   - **What:** `redis_region1` (Mumbai Primary) streams state asynchronously to `redis_region2` (Hyderabad Replica, `--replica-read-only yes`). Both auth clusters normally route writes/atomic commands (`SET`, `SET NX`, `GETDEL`) to `REDIS_PRIMARY_URL` (`redis_region1`). If `redis_region1` fails, `RedisCacheStore._runWrite` catches the network/timeout error, uses a shared `_promotingPromise` lock so concurrent requests issue `REPLICAOF NO ONE` **exactly once**, promotes `redis_region2` to standalone master, and retries locally.
   - **Why:** A read-only replica rejects `SET NX` and `GETDEL` with `READONLY` errors, and two active regions writing to independent un-synced caches would allow cross-region replay attacks or OTP verification misses. Routing normal writes to Primary gives cross-region consistency, while auto-promotion ensures **zero lost OTPs and zero manual intervention** if Region 1's entire compute + cache tier goes offline.

8. **Multi-AZ Load Balancing, Failover, Chaos Tooling & Hardening (`docker-compose.az.yml`, `nginx.conf`, `deploy-ec2.sh`, `chaos-monitor.js`)**
   - **What:** Supports both **two separate EC2 instances across `ap-south-1a` & `ap-south-1b` behind an AWS ALB** (`docker-compose.az.yml`, `deploy-ec2.sh --mode az-primary / az-replica`) and single-host NGINX (`docker-compose.yml` with `max_fails=2 fail_timeout=5s`, `proxy_next_upstream`, `worker_connections 4096`). Express serves the dynamic Multi-AZ status UI at `GET /` (HTML for browsers, JSON for API clients) so it works identically behind AWS ALB or NGINX. `chaos-monitor.js` probes `/health` and signed OTP flows continuously during live Chaos/Failover tests, exporting JSON + CSV timelines.
   - **Why:** Satisfies true Multi-AZ cloud fault tolerance (surviving an entire EC2 instance stop in Zone A), avoids `t3.micro` OOM via 1 GiB swap in `deploy-ec2.sh`, and documents `5s` ALB target health checks so failover happens in ~10s instead of AWS's 60s default.

---

## 4. Verification, Benchmarks & Current Project Status

| Phase | Scope | Status & Evidence |
| :--- | :--- | :--- |
| **Phase 0–1** | Core stateless API, Verhoeff, HMAC, replay lock, AES-256-GCM, audit logger | **Complete** — tested in [`auth.test.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/tests/auth.test.js) |
| **Phase 2** | Multi-region Compose topology, NGINX round-robin & passive failover, live `/` UI | **Complete** — [`docker-compose.yml`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/docker-compose.yml), [`nginx.conf`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/nginx/nginx.conf) |
| **Phase 3** | Dual-region Redis Primary $\rightarrow$ Replica sync, `/health` telemetry, auto-promotion, scaling | **Complete** — tested in [`replication.test.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/tests/replication.test.js) |
| **Phase 4** | Multi-AZ EC2 (`ap-south-1a`/`1b`) + ALB & Single-VM deploy scripts, chaos monitor | **Ready to Deploy** — [`DEPLOYMENT.md`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/DEPLOYMENT.md), [`docker-compose.az.yml`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/docker-compose.az.yml), [`deploy-ec2.sh`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/scripts/deploy-ec2.sh) |
| **Phase 5** | Empirical `k6` load & failure scenarios (`T1`–`T6`) + live AWS chaos video | **Scripts Ready** — [`k6/`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/k6), [`chaos-monitor.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/scripts/chaos-monitor.js) |

### Local Verification Summary (Executed on Node.js v20.20.2)
Full logs, CSV timelines, and raw JSON are stored in [`prototype/results/TEST_RESULTS.md`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/results/TEST_RESULTS.md):
- **Unit & Phase 3 Replication Tests:** **12/12 passed** (`10357.81 ms`), verifying Verhoeff D5, random-IV AES-256-GCM, `/` HTML & JSON negotiation, OTP lifecycle, replay filter (T6), TTL expiry (T5), single-flight `REPLICAOF NO ONE` failover, and cross-region HTTP verification.
- **Dual-Region Loopback Micro-Benchmark** (`run-local-verification.js`, stateful Primary $\rightarrow$ Replica Redis mock, 10 concurrent workers, 500 signed requests): **`1174.7 req/s`**, `0` failures, `p50: 7.83 ms`, `p95: 11.17 ms`, `p99: 19.61 ms`.
- **Local Multi-AZ Chaos/Failover Simulation** (`run-local-chaos-sim.js`, 12 ticks across `ap-south-1a` & `ap-south-1b` with Zone A killed after tick 5): **`12/12` (`100%`) health & auth availability**, automatic promotion to `role: master [PROMOTED]` on Zone B.
- **Remaining Live Execution:** Deploy across `ap-south-1a` & `ap-south-1b` behind AWS ALB following [`DEPLOYMENT.md`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/DEPLOYMENT.md), record the live Chaos/Failover test with `chaos-monitor.js` while stopping Zone A EC2, and run `./k6/run_benchmarks.sh` to capture live cloud metrics for the final report.

---

## 5. Quick Reference: File Map

- **Reports & Case Study Docs:** [`Group_44_Week2_Aadhaar_Report.pdf`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/Group_44_Week2_Aadhaar_Report.pdf), [`PROJECT_GUIDE.md`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/PROJECT_GUIDE.md), [`papers/`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/papers)
- **Microservice & UI Code:** [`authRoutes.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/routes/authRoutes.js), [`index.html`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/public/index.html), [`hmacAuth.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/middleware/hmacAuth.js), [`cacheService.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/services/cacheService.js), [`crypto.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/utils/crypto.js), [`verhoeff.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/utils/verhoeff.js), [`auditLogger.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/auth-service/src/services/auditLogger.js)
- **Containers & Ingress:** [`docker-compose.az.yml`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/docker-compose.az.yml), [`docker-compose.yml`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/docker-compose.yml), [`docker-compose.prod.yml`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/docker-compose.prod.yml), [`docker-compose.tls.yml`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/docker-compose.tls.yml), [`nginx.conf`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/nginx/nginx.conf), [`nginx.ssl.conf`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/nginx/nginx.ssl.conf)
- **Deployment & Testing:** [`DEPLOYMENT.md`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/DEPLOYMENT.md), [`deploy-ec2.sh`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/scripts/deploy-ec2.sh), [`chaos-monitor.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/scripts/chaos-monitor.js), [`test-client.js`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/scripts/test-client.js), [`k6/`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/k6), [`TEST_RESULTS.md`](file:///c:/Users/Vignan/Documents/SEM7/Cloud_Computing/Project/prototype/results/TEST_RESULTS.md)

