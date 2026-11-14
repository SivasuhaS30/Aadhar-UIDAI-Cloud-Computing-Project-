# Aadhaar 1:1 Auth & OTP Microservice Prototype

Scaled-down cloud-native implementation of UIDAI's synchronous 1:1 OTP Authentication pipeline.

## Implementation Status
- [x] **Phase 0 & 1:** Core Node.js / Express 4 stateless microservice with Verhoeff UID validation, `HMAC-SHA256` request signing, `SET ... NX EX 60` replay defense (T6), `AES-256-GCM` response encryption with random 96-bit IVs (fixing Sec. 6.4 IV-reuse vulnerability), non-blocking audit logging, and automated test suite.
- [x] **Phase 2:** Multi-region container topology with Docker Compose (`region1_auth` in Mumbai, `region2_auth` in Hyderabad), NGINX 1.25 reverse proxy with Round-Robin distribution and passive health failover (`proxy_next_upstream`), and unified live telemetry dashboard at `GET /` (served by both NGINX and Express for ALB compatibility).
- [x] **Phase 3:** Dual-Region Redis Sync upgrade (`redis_region1` Primary $\rightarrow$ `redis_region2` Replica), `/health` replication telemetry, horizontal replica scaling support (`--scale region1_auth=3` for T2), and automatic replica promotion (`REPLICAOF NO ONE`) on primary outage.
- [ ] **Phase 4 (Deployment Ready — Run on AWS):** Two-server Multi-AZ (`ap-south-1a` & `ap-south-1b`) + AWS Application Load Balancer setup ([`docker-compose.az.yml`](./docker-compose.az.yml), [`scripts/deploy-ec2.sh`](./scripts/deploy-ec2.sh), [`scripts/chaos-monitor.js`](./scripts/chaos-monitor.js)) and single-VM option ([`docker-compose.prod.yml`](./docker-compose.prod.yml)), documented in [`DEPLOYMENT.md`](./DEPLOYMENT.md).
- [ ] **Phase 5 (Scripts Ready — Run Post-Deploy):** Week 3 empirical load testing (`k6` scenarios T1–T6 in [`k6/`](./k6)) and live AWS Chaos/Failover test exporting metrics to [`results/`](./results).

---

## Local Running & Verification

### 1. Unit, Replication & Local Chaos/Loopback Verification (Node.js 20)

```bash
cd prototype/auth-service
npm test

cd ..
node scripts/run-local-verification.js
node scripts/run-local-chaos-sim.js
```

Captured verification logs, chaos timelines, and metrics are saved in [`results/TEST_RESULTS.md`](./results/TEST_RESULTS.md).

### 2. Full Multi-Region Stack (Single-Host Docker Compose)

```bash
cd prototype
docker compose up -d --build
docker compose ps
```

Verify endpoints:

```bash
# Live telemetry dashboard (open in browser)
curl -I -H "Accept: text/html" http://localhost/

# NGINX load balancer health
curl http://localhost/nginx-health

# Load-balanced regional auth health (alternates "mumbai" vs "hyderabad" + replication state)
curl http://localhost/health
curl http://localhost/health

# End-to-end HMAC-signed smoke test & continuous chaos monitor
node scripts/test-client.js http://localhost
node scripts/chaos-monitor.js --url http://localhost --duration-sec 30
```

---

## Cloud Hosting (Multi-AZ AWS ALB & Single-VM Modes)

Follow [`DEPLOYMENT.md`](./DEPLOYMENT.md) to deploy across two separate EC2 instances in **`ap-south-1a`** and **`ap-south-1b`** behind an **AWS Application Load Balancer** using [`docker-compose.az.yml`](./docker-compose.az.yml) and [`scripts/deploy-ec2.sh`](./scripts/deploy-ec2.sh), then run [`scripts/chaos-monitor.js`](./scripts/chaos-monitor.js) while stopping the Zone A instance for your live Chaos/Failover demonstration.

---

## Container Architecture

### Mode A: Multi-AZ Per-EC2 Node ([`docker-compose.az.yml`](./docker-compose.az.yml) behind AWS ALB)
| Container | Role | Port |
| :--- | :--- | :--- |
| `aadhaar_auth_az` | Stateless Express Auth API + `/` Live Dashboard | `80 -> 3000` (ALB target) |
| `aadhaar_redis_az` | Primary Redis (Zone A) or Replicated Auto-Promoting Redis (Zone B) | `6379` (VPC SG restricted) |

### Mode B: Single-Host Simulated Stack ([`docker-compose.yml`](./docker-compose.yml))
| Service / Container | Role | Simulated Region | Internal Port | Host Port |
| :--- | :--- | :--- | :--- | :--- |
| `nginx` (`aadhaar_nginx_lb`) | Reverse Proxy, Dashboard (`/`), & Load Balancer | Global Ingress | `80` (`443` TLS opt.) | `80` (or `$NGINX_PORT`) |
| `region1_auth` (scalable) | Stateless Express Auth API | `mumbai` | `3000` | *Internal only* |
| `region2_auth` (scalable) | Stateless Express Auth API | `hyderabad` | `3000` | *Internal only* |
| `redis_region1` (`aadhaar_redis_region1`) | Primary In-Memory OTP/Replay Cache | `mumbai` (Primary) | `6379` | *Internal only* |
| `redis_region2` (`aadhaar_redis_region2`) | Replicated In-Memory Cache (Auto-Promotes) | `hyderabad` (Replica) | `6379` | *Internal only* |
