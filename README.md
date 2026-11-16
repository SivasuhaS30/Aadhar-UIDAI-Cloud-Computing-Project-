# Aadhaar (UIDAI) — Cloud & Data-Center Architecture at National Scale

**Course:** IT457 – Cloud Computing
**Theme:** Government & Public Digital Infrastructure
**Group:** 44

---

## 🌐 Live AWS Deployment & Failover Demonstration

A live multi-AZ deployment of a scaled-down Aadhaar-inspired authentication service on AWS.

| Resource | Link |
| :--- | :--- |
| Live Application Dashboard | [Open Application](http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/) |
| Service Health Check | [Check Health Endpoint](http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/health) |
| Multi-AZ Chaos/Failover Video | [Watch Failover Demonstration](https://drive.google.com/file/d/1knZ0NuT9ByiJ9Jv9SY7KTEyB0pXB5Xma/view?usp=drive_link) |
| Empirical Test Results | [View Test Results](./prototype/results/TEST_RESULTS.md) |

| Component | Configuration |
| :--- | :--- |
| Cloud Provider | Amazon Web Services (AWS) |
| Region | Sydney (`ap-southeast-2`) |
| Availability Zones | `ap-southeast-2a`, `ap-southeast-2b` |
| Compute | One EC2 `t3.micro` instance per Availability Zone |
| Load Balancer | Application Load Balancer `aadhaar-alb` (health check `GET /health` every 5 s) |
| Application | Node.js 20 / Express 4 (Docker, port 80 → 3000) |
| Cache Layer | Redis 7 — primary in Zone A, replica in Zone B |

> **Note:** The live endpoint uses HTTP. The repository also includes an optional TLS configuration for HTTPS experiments.
>
> **Note:** [`prototype/DEPLOYMENT.md`](./prototype/DEPLOYMENT.md) uses `ap-south-1` (Mumbai) as its example region. The live deployment runs in `ap-southeast-2` (Sydney).

---

## 📌 Project Overview

Aadhaar is one of the world's largest biometric digital identity systems, covering more than 1.4 billion residents. This project studies the cloud and data-center architecture of the Unique Identification Authority of India (UIDAI) and covers four areas:

1. **1:N Biometric Deduplication:** Parallel biometric matching to keep identities unique during enrollment.
2. **1:1 Real-Time Authentication:** Low-latency identity verification returning a Yes/No result.
3. **Distributed Infrastructure:** Active-active data centers, distributed storage, fault tolerance and security.
4. **Hands-On Implementation:** A scaled-down, highly available authentication microservice with load balancing, distributed caching and automated failover.

The implementation covers the **1:1 OTP authentication workflow** only. The 1:N deduplication pipeline is studied in the case study but **not** implemented.

---

## 🏗️ System Architecture

### Reference Architecture — UIDAI

- Primary and Disaster Recovery data centers for service continuity.
- Distributed storage (HDFS, HBase, Cassandra, MySQL).
- Parallel biometric deduplication for enrollment.
- Real-time 1:1 authentication.
- Registered Devices, public-key cryptography and HSMs.

### Implemented Prototype

<img width="590" height="572" alt="image" src="https://github.com/user-attachments/assets/15748812-c5d6-475d-b14a-d3fefdc8ffe2" />

*Figure 1. Application Load Balancer, two Availability Zones (each with an auth service and Redis) and Redis primary → replica replication.*

- **Application Load Balancer:** Distributes requests between healthy instances.
- **Stateless Auth Services:** Two Node.js/Express containers, one per Availability Zone.
- **Redis Primary and Replica:** Stores temporary OTP and replay-protection state. Both zones write to the Zone A primary over private VPC addresses; the Zone B replica replicates from it.
- **Health Checks:** `GET /health` lets the ALB detect unhealthy targets.
- **Automated Redis Promotion:** When a write finds the primary unreachable, the replica is promoted (`REPLICAOF NO ONE`) and the write is retried.
- **Network Isolation:** Port 80 is open only from the ALB security group; port 6379 only between the two instances.

### API Endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/`, `/dashboard` | Live telemetry dashboard |
| `GET` | `/health` | Region, Redis and replication status (used by the ALB) |
| `POST` | `/auth/otp/generate` | Generate an OTP for a UID |
| `POST` | `/auth/verify` | Verify UID + transaction ID + OTP |

### OTP Authentication Workflow

<img width="623" height="513" alt="image" src="https://github.com/user-attachments/assets/4ea4e6da-eac3-4183-8e9a-5fea5cb12a43" />

*Figure 2. Request flow showing HMAC verification, replay protection, OTP consumption, hash comparison and encrypted assertion.*

**Generate (`POST /auth/otp/generate`)**

1. The client signs the request with HMAC-SHA256 over `timestamp.rawBody` (`x-timestamp`, `x-signature` headers).
2. The server validates the signature and timestamp (60 s window).
3. A Redis replay lock (`SET NX EX 60`) rejects duplicate signed requests.
4. The UID is checked with the Verhoeff checksum.
5. A transaction ID and 6-digit OTP are generated; SHA-256 hashes of the UID and OTP are stored in Redis for 300 s.
6. The service returns the transaction ID and `OTP_SENT`. SMS is simulated; demo mode also returns the OTP.

**Verify (`POST /auth/verify`)**

1. The client sends the UID, transaction ID and OTP in a newly signed request.
2. Signature, timestamp and replay checks run again.
3. The OTP record is consumed with Redis `GETDEL`. A missing, expired or used record returns 400 `OTP_EXPIRED`.
4. Submitted hashes are compared with the stored hashes.
5. A match returns `authStatus: "Y"`; a mismatch returns HTTP 401 with a signed `"N"` assertion.
6. The assertion is HMAC-signed and AES-256-GCM encrypted. An audit event is logged asynchronously.

**Security Mechanisms**

| Mechanism | Purpose |
| :--- | :--- |
| Verhoeff Checksum | Validates UID checksum |
| HMAC-SHA256 | Request integrity; signs the response assertion |
| Timestamp Validation | Rejects stale requests |
| Redis Replay Protection | Prevents duplicate signed requests |
| SHA-256 | Avoids storing raw UID and OTP |
| Redis TTL / `GETDEL` | Expires OTPs and ensures single use |
| AES-256-GCM + random IV | Encrypts and authenticates the assertion |

---

## ☁️ High Availability & Disaster Recovery

**Traffic failover:** The ALB health check marks a failed target unhealthy and sends requests to the remaining healthy zone.

**Redis state failover:** Traffic failover alone is not enough because the service depends on Redis state. When a write fails against the primary, the Zone B replica is promoted with `REPLICAOF NO ONE` and the write is retried, so OTP and replay-protection writes continue.

**Chaos experiment:**

1. Both zones serve requests while `scripts/chaos-monitor.js` sends continuous authentication requests.
2. The Zone A EC2 instance (application and Redis) is stopped.
3. The ALB detects the unhealthy target and redirects traffic to Zone B.
4. Zone B promotes its Redis replica on the first failed write.
5. Authentication requests resume through the surviving zone.

> **Important:** Redis replication is asynchronous, so a write not yet replicated before the failure may be lost. The prototype demonstrates automated recovery, not zero downtime or zero data loss.

---

## 🧪 Experimental Evaluation & Testing

- **Unit and integration tests:** 12/12 passed (Node.js built-in test runner). Covers authentication logic, checksum, OTP handling and replay protection.
- **Local benchmark:** 1174.7 requests/second (loopback).
- **Local dual-zone simulation:** Docker Compose runs two auth services and two Redis instances behind NGINX.
- **AWS Multi-AZ experiments:** ALB health transitions, traffic redirection, Redis promotion and latency.

**k6 load and failover scenarios**

| Scenario | Experiment | Objective |
| :--- | :--- | :--- |
| T1 | Baseline | Normal system performance |
| T2 | Scaling | Behaviour under increasing load |
| T3 | Saturation | Performance limits |
| T4 | Failover | Continuity during failure |
| T5 | TTL Expiry | OTP expiration |
| T6 | Replay Protection | Duplicate signed-request rejection |

Detailed outputs are in [`prototype/results/`](./prototype/results).

---

## 🛠️ Technology Stack

| Category | Technologies |
| :--- | :--- |
| Backend | Node.js 20, Express 4, ioredis |
| Load Balancing | AWS ALB (cloud), NGINX 1.25 (local) |
| Cache | Redis 7 |
| Containers | Docker, Docker Compose |
| Cloud | AWS EC2, VPC, Availability Zones, ALB, Security Groups |
| Load Testing | Grafana k6 |
| Security | HMAC-SHA256, SHA-256, AES-256-GCM, Verhoeff |
| Monitoring | Health endpoint, live dashboard, chaos-monitor scripts |

---

## 📁 Repository Structure

```text
.
├── Group44.pdf, Week1_Aadhaar_Case_Study_Summary.docx
├── Group_44_Week2_Aadhaar_Report.pdf
├── Group_44_Week3_Results_Addon.pdf
├── Group_44_Week4_Final_Report.pdf
├── PROJECT_HANDBOOK.md, PROJECT_GUIDE.md, Project_Instructions.md
├── papers/                  # Primary research papers
└── prototype/
    ├── auth-service/        # Stateless Express auth service
    ├── nginx/               # Local load balancer and optional TLS
    ├── k6/                  # Load and failover scenarios (T1–T6)
    ├── scripts/             # Deploy, smoke test, chaos monitor, local sims
    ├── results/             # Benchmarks, test outputs, chaos timelines
    ├── docker-compose.yml       # Local dual-zone simulation
    ├── docker-compose.az.yml    # Per-AZ EC2 stack behind the ALB
    ├── docker-compose.prod.yml  # Production resource/logging override
    ├── docker-compose.tls.yml   # Optional HTTPS override
    └── DEPLOYMENT.md
```

---

## 🚀 Running the Local Prototype

Requires Docker, Docker Compose and Node.js 20+.

```bash
cd prototype
docker compose up --build                       # NGINX, two auth services, two Redis
node scripts/test-client.js http://localhost    # signed smoke test
docker compose down
```

Open `http://localhost/` for the dashboard or `http://localhost/health` for service status. For AWS and TLS deployment, see [`prototype/DEPLOYMENT.md`](./prototype/DEPLOYMENT.md).

---

## 📚 Primary Research & References

Archived in [`papers/`](./papers):

1. **UIDAI Technology Architecture Whitepaper (2014)**
2. **CAG Performance Audit Report No. 24 of 2021**
3. **UIDAI Biometrics Committee Report (2012)**
4. **Tiwari et al. — India's Aadhaar Biometric ID: Structure, Security & Vulnerabilities**

---

## ⚠️ Scope & Limitations

This is an academic, scaled-down implementation inspired by UIDAI's architecture, **not** a production Aadhaar system.

- Only the 1:1 OTP workflow is implemented; biometrics and 1:N deduplication are out of scope.
- SMS delivery is simulated.
- HMAC and AES-GCM do not replace HSM-backed key management.
- Redis replication is asynchronous and may lose recent writes during failure.
- The audit logger is application-level (JSON log lines), not a durable message queue.

---

## 🗓️ Project Milestones

| Week | Milestone | Status |
| :--- | :--- | :--- |
| Week 1 | [Literature survey and one-page summary](./Group44.pdf) | Completed |
| Week 2 | [Architecture analysis and blueprint](./Group_44_Week2_Aadhaar_Report.pdf) | Completed |
| Week 3 | [Microservice, benchmarks and results add-on](./Group_44_Week3_Results_Addon.pdf) | Completed |
| Week 4 | [Live AWS deployment, failover demo and final report](./Group_44_Week4_Final_Report.pdf) | Completed |
| Week 5 | Project viva and final defense | Upcoming |

---

## 🎯 Project Objective

To understand how distributed cloud and data-center architectures support large-scale identity systems, and to demonstrate high-availability principles — secure request authentication, distributed caching, load balancing, health monitoring and automated failover — through a practical authentication service.
