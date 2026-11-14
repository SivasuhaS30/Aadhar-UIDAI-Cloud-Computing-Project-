# Phase 4 — AWS EC2 & Multi-AZ Load Balancer Deployment Runbook

This runbook supports two deployment topologies:
- **Option A (Recommended — Required by `IT457 Project Implementation Guide.pdf` Theme 5):** Two separate EC2 instances across **two AWS Availability Zones (`ap-south-1a` and `ap-south-1b`)** behind an **AWS Application Load Balancer (ALB)**, with cross-AZ Redis Primary $\rightarrow$ Replica sync and live Chaos/Failover verification.
- **Option B (Single-VM Simulated Topology):** One EC2 `t3.micro` running all 5 containers (`nginx`, Mumbai/Hyderabad auth, dual Redis) via Docker Compose.

---

## Option A: Two-Server Multi-AZ Deployment + AWS ALB (Theme 5 Spec)

### 1. Security Groups (Create Before Launching Instances)
1. **`aadhaar-alb-sg` (Load Balancer Security Group):**
   - Inbound: `HTTP (80/TCP)` from `0.0.0.0/0` (and `HTTPS (443/TCP)` from `0.0.0.0/0` if using ACM TLS on ALB).
   - Outbound: All traffic.
2. **`aadhaar-ec2-sg` (EC2 Nodes Security Group):**
   - Inbound: `HTTP (80/TCP)` from Source **`aadhaar-alb-sg`** (not public internet).
   - Inbound: `Custom TCP (6379/TCP)` from Source **`aadhaar-ec2-sg`** (self-referencing rule allowing Zone B Replica to sync with Zone A Primary over private VPC IPs only — **never** expose `6379` to `0.0.0.0/0`).
   - Inbound: `SSH (22/TCP)` from *My IP*.

### 2. Launch Two `t3.micro` Ubuntu Instances in Different AZs
- **EC2 Instance 1 (Zone A — Primary):**
  - Region/AZ: `ap-south-1` $\rightarrow$ Subnet in **`ap-south-1a`**
  - AMI: Ubuntu Server 24.04 LTS (`x86_64`), Type: `t3.micro`, Storage: `16 GiB gp3`, SG: `aadhaar-ec2-sg`
- **EC2 Instance 2 (Zone B — Replica):**
  - Region/AZ: `ap-south-1` $\rightarrow$ Subnet in **`ap-south-1b`**
  - AMI: Ubuntu Server 24.04 LTS (`x86_64`), Type: `t3.micro`, Storage: `16 GiB gp3`, SG: `aadhaar-ec2-sg`

### 3. Deploy Zone A (Primary) & Zone B (Replica)
SSH into **Instance 1 (`ap-south-1a`)**:
```bash
git clone https://github.com/SivasuhaS30/Aadhar-UIDAI-Cloud-Computing-Project-.git
cd Aadhar-UIDAI-Cloud-Computing-Project-/prototype
chmod +x scripts/deploy-ec2.sh
./scripts/deploy-ec2.sh --mode az-primary --region ap-south-1a
```
At completion, `deploy-ec2.sh` prints your private IP and exact Zone B command with matching `HMAC_SECRET` and `AES_KEY`.

SSH into **Instance 2 (`ap-south-1b`)** and run the printed command:
```bash
git clone https://github.com/SivasuhaS30/Aadhar-UIDAI-Cloud-Computing-Project-.git
cd Aadhar-UIDAI-Cloud-Computing-Project-/prototype
chmod +x scripts/deploy-ec2.sh
./scripts/deploy-ec2.sh --mode az-replica --region ap-south-1b --primary-ip <ZONE_A_PRIVATE_IP> --hmac-secret <SECRET> --aes-key <KEY>
```

Verify cross-AZ replication on Zone B:
```bash
docker exec aadhaar_redis_az redis-cli INFO replication | grep -E "role|master_link_status"
# Expected: role:slave, master_link_status:up
```

### 4. Configure AWS Application Load Balancer (ALB)
1. **EC2 $\rightarrow$ Target Groups $\rightarrow$ Create target group:**
   - Target type: **Instances**, Protocol/Port: `HTTP : 80`
   - **Health checks (Critical for fast Chaos/Failover):**
     - Health check path: **`/health`**
     - Healthy threshold: **`2`**
     - Unhealthy threshold: **`2`** *(down from default 2x30s)*
     - Timeout: **`3 seconds`**
     - Interval: **`5 seconds`** *(cuts failure detection to ~10 seconds)*
     - Success codes: `200`
   - Register **both** `ap-south-1a` and `ap-south-1b` instances.
2. **EC2 $\rightarrow$ Load Balancers $\rightarrow$ Create Application Load Balancer:**
   - Scheme: **Internet-facing**, IPv4
   - Network mapping: Select **both `ap-south-1a` and `ap-south-1b` subnets**
   - Security group: **`aadhaar-alb-sg`**
   - Listener: `HTTP : 80` $\rightarrow$ Forward to your target group.
3. Open `http://<ALB-DNS-NAME>/` in a browser. You will see the live Multi-AZ Dashboard alternating probes across `ap-south-1a` and `ap-south-1b`.

### 5. Live Chaos / Failover Test (Deliverable 3 & Step 5)
1. In your browser on `http://<ALB-DNS-NAME>/`, click **"Start Live Chaos Probe (1s)"**.
2. In your local terminal, start the CLI chaos monitor (using the shared `HMAC_SECRET` from Zone A's `.env`):
   ```bash
   node prototype/scripts/chaos-monitor.js --url http://<ALB-DNS-NAME> --hmac-secret <SECRET> --interval-ms 500 --duration-sec 90 --tag aws-alb
   ```
3. In AWS EC2 Console, select **Instance 1 (`ap-south-1a`) $\rightarrow$ Instance state $\rightarrow$ Stop instance** (start recording screen before clicking Stop).
4. Observe:
   - ALB marks `ap-south-1a` **Unhealthy** within ~10s and routes 100% of traffic to `ap-south-1b`.
   - Zone B automatically promotes its Redis replica (`REPLICAOF NO ONE`, dashboard & monitor show `[PROMOTED]` / `role: master`) and continues verifying OTPs with zero downtime.
5. Capture screenshots of:
   - AWS EC2 Instances & Target Group Health dashboard (showing `ap-south-1a` unhealthy/stopped and `ap-south-1b` healthy).
   - Live browser dashboard + `chaos-monitor.js` terminal output and generated `results/chaos-report-aws-alb-*.json` / `.csv`.
6. *(After restarting Zone A later)* Re-attach Zone B replication cleanly by restarting Zone B's compose stack once Zone A is back up:
   ```bash
   docker compose -f docker-compose.az.yml restart
   ```

---

## Option B: Single-EC2 Simulated Multi-Region Deployment

1. Launch **1** `t3.micro` Ubuntu instance in `ap-south-1` with ports `22`, `80`, and `443` open.
2. Clone and deploy:
   ```bash
   git clone https://github.com/SivasuhaS30/Aadhar-UIDAI-Cloud-Computing-Project-.git
   cd Aadhar-UIDAI-Cloud-Computing-Project-/prototype
   chmod +x scripts/deploy-ec2.sh
   ./scripts/deploy-ec2.sh --mode single
   ```
3. Verify `http://<EC2-PUBLIC-IP>/` and run `k6` scenarios `T1`–`T6`:
   ```bash
   ./k6/run_benchmarks.sh
   ```

### Optional HTTPS / TLS (Option B with Domain Name)
```bash
sudo apt-get install -y certbot
sudo docker compose stop nginx
sudo certbot certonly --standalone -d <YOUR_DOMAIN>
mkdir -p nginx/certs
sudo cp /etc/letsencrypt/live/<YOUR_DOMAIN>/fullchain.pem nginx/certs/
sudo cp /etc/letsencrypt/live/<YOUR_DOMAIN>/privkey.pem nginx/certs/
sudo chown -R "$USER:$USER" nginx/certs
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.tls.yml up -d
```
