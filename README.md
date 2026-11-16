# Aadhaar (UIDAI) — Cloud & Data-Center Architecture at National Scale

**Course:** IT457 – Cloud Computing  
**Theme:** Government & Public Digital Infrastructure  
**Project:** Aadhaar (UIDAI) Biometric ID System, Cloud & Data-Center Architecture  
**Group:** 44

---

## 🌐 Live AWS Deployment & Failover Demonstration

This project includes a live multi-AZ deployment of a scaled-down Aadhaar-inspired authentication service on AWS.

| Resource | Link |
|---|---|
| **Live Application Dashboard** | [Open Application](http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/) |
| **Service Health Check** | [Check Health Endpoint](http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/health) |
| **Multi-AZ Chaos/Failover Video** | [Watch Failover Demonstration](https://drive.google.com/file/d/1knZ0NuT9ByiJ9Jv9SY7KTEyB0pXB5Xma/view?usp=drive_link) |
| **Empirical Test Results** | [View Test Results](./prototype/results/TEST_RESULTS.md) |

### AWS Deployment Configuration

| Component | Configuration |
|---|---|
| Cloud Provider | Amazon Web Services (AWS) |
| Region | Sydney (`ap-southeast-2`) |
| Availability Zones | `ap-southeast-2a`, `ap-southeast-2b` |
| Load Balancer | Application Load Balancer (ALB) |
| ALB Name | `aadhaar-alb` |
| Application | Node.js 20 / Express 4 |
| Cache Layer | Redis 7 |
| Deployment Model | Multi-AZ |

> **Note:** The live endpoint uses HTTP. The repository also includes an optional TLS configuration for HTTPS experiments.

---

## 📌 Project Overview

Aadhaar is one of the world's largest biometric digital identity systems, covering more than 1.4 billion residents. Its architecture presents important challenges in distributed computing, large-scale data management, security, availability and real-time authentication.

This project studies the cloud and data-center architecture of the Unique Identification Authority of India (UIDAI), with particular attention to the infrastructure and engineering principles required to support a national-scale identity platform.

The project explores four major areas:

1. **1:N Biometric Deduplication — Enrollment Pipeline:** Computationally intensive biometric matching to identify duplicate identities and maintain uniqueness during enrollment.
2. **1:1 Real-Time Authentication:** Verification of an individual's identity through authentication requests, with a focus on secure responses and low-latency processing.
3. **Distributed Infrastructure:** Active-active data-center architecture, distributed storage, horizontal scalability, fault tolerance and security mechanisms.
4. **Hands-On Implementation:** Development and benchmarking of a scaled-down, high-availability authentication microservice with load balancing, distributed caching and automated failover.

The practical implementation focuses on the **1:1 OTP authentication workflow**. The 1:N biometric deduplication pipeline is studied as part of the architectural case study and is not implemented in the prototype.

---

## 🏗️ System Architecture

The project examines the distributed infrastructure principles behind Aadhaar and implements a simplified high-availability architecture inspired by those principles.

### 1. Reference Architecture — UIDAI

The case study explores the following architectural components:

- **Primary and Disaster Recovery Data Centers:** Distributed infrastructure designed to support service continuity.
- **Distributed Storage:** Technologies such as HDFS, HBase, Cassandra and MySQL, as discussed in the reference architecture.
- **Biometric Deduplication:** Parallel biometric matching for enrollment and identity uniqueness.
- **Real-Time Authentication:** A 1:1 authentication workflow that returns a Yes/No response.
- **Security Infrastructure:** Registered Devices, public-key cryptography and Hardware Security Modules (HSMs).

### 2. Implemented Prototype Architecture

The practical prototype demonstrates a simplified two-zone authentication system.

<img width="1102" height="615" alt="image" src="https://github.com/user-attachments/assets/4339c1b6-d6e1-43d7-aa95-9dc84ea5506f" />


<!-- Insert your AWS Multi-AZ architecture diagram here. -->
<!-- Suggested file: docs/images/aws-multi-az-architecture.png -->

*Figure 1. Implemented high-availability architecture showing the Application Load Balancer, two Availability Zones, authentication services and Redis primary/replica configuration.*

The prototype contains:

- **Application Load Balancer:** Distributes incoming requests between healthy application instances.
- **Stateless Authentication Services:** Two Node.js/Express instances running the same application.
- **Redis Primary and Replica:** Stores temporary OTP and replay-protection state, with replication between Redis instances.
- **Health Checks:** Allows the load balancer to identify unhealthy application targets.
- **Automated Redis Promotion:** Promotes the secondary Redis replica when a write operation detects failure of the primary connection.

### 3. OTP Authentication Workflow

The implemented authentication workflow consists of two main API operations:

- `POST /generate-otp`
- `POST /verify-otp`

<img width="1107" height="616" alt="image" src="https://github.com/user-attachments/assets/0de10228-0986-460c-ad05-d54eb1dcae31" />

<!-- Insert your OTP authentication sequence diagram here. -->
<!-- Suggested file: docs/images/otp-authentication-workflow.png -->

*Figure 2. End-to-end OTP authentication workflow showing HMAC verification, replay protection, Redis storage, OTP verification and encrypted authentication assertion generation.*

#### Request Generation

1. The client submits a UID.
2. The client generates an HMAC-SHA256 signature using a shared secret, timestamp and raw request body.
3. The server validates the timestamp and signature.
4. Redis replay protection prevents reuse of the same signed request.
5. The UID is validated using the Verhoeff checksum algorithm.
6. A unique transaction ID and six-digit OTP are generated.
7. The UID and OTP are hashed using SHA-256 and stored in Redis with a 300-second expiry.
8. The service returns the transaction ID and OTP-generation status.

#### OTP Verification

1. The client submits the UID, transaction ID and OTP in a newly signed request.
2. The server validates the request signature and replay protection.
3. The application retrieves the OTP record using Redis `GETDEL`.
4. The submitted UID and OTP hashes are compared with the stored hashes.
5. A successful authentication assertion is generated.
6. The assertion is signed using HMAC and encrypted using AES-256-GCM.
7. The service returns the authentication result.

#### Security Mechanisms

| Mechanism | Purpose |
|---|---|
| Verhoeff Checksum | Validates UID checksum |
| HMAC-SHA256 | Request integrity and authentication |
| Timestamp Validation | Rejects stale requests |
| Redis Replay Protection | Prevents duplicate signed requests |
| SHA-256 | Avoids storing raw UID and OTP values |
| Redis TTL | Automatically expires temporary OTP records |
| Redis GETDEL | Ensures OTP records are consumed atomically |
| AES-256-GCM | Encrypts and authenticates the assertion |
| Random IV | Provides fresh encryption randomness |

---

## ☁️ High Availability & Disaster Recovery

High availability is the central implementation objective of this project.

The prototype uses two application zones with Redis replication to demonstrate service continuity when the primary zone becomes unavailable.

### Traffic Failover

The Application Load Balancer periodically checks the health of registered application targets.

When an application target becomes unhealthy:

1. The ALB detects failed health checks.
2. The unhealthy target is removed from normal traffic routing.
3. Requests are directed towards the remaining healthy target.

### Redis State Failover

Traffic failover alone is not sufficient because the authentication service also depends on temporary state stored in Redis.

The prototype implements a Redis promotion mechanism:

1. The secondary zone maintains a Redis replica.
2. A write operation fails when the primary Redis connection becomes unavailable.
3. The application detects the connection failure.
4. The secondary replica is promoted using `REPLICAOF NO ONE`.
5. The failed write is retried against the promoted Redis instance.

This allows the secondary authentication service to continue performing OTP and replay-protection writes after the primary Redis instance becomes unavailable.

### Chaos / Failover Experiment



The documented AWS chaos experiment follows this sequence:

1. Both Availability Zones initially serve requests.
2. Continuous authentication requests are generated.
3. The primary zone's application and Redis instance are stopped.
4. The ALB detects the unhealthy target.
5. Traffic is redirected to the secondary zone.
6. The secondary Redis replica is promoted to primary when a write encounters the failed primary.
7. Authentication requests resume through the surviving zone.

> **Important:** Redis replication is asynchronous. A write that has not replicated before the primary failure may not be available in the secondary zone. Therefore, the prototype demonstrates automated recovery, but does not guarantee zero downtime or zero data loss.

---

## 🧪 Experimental Evaluation & Testing

The project evaluates application correctness, security, performance and high availability through local experiments and AWS deployment tests.

### 1. Unit and Integration Testing

- Reported result: **12/12 tests passed**.
- Validates authentication logic, checksum verification, OTP handling, replay protection and related application behaviour.
- Uses the Node.js built-in test runner and assertions.

### 2. Local Performance Benchmark

- Reported benchmark: **1174.7 requests/second**.
- Conducted using the local loopback benchmark.
- Measures the request-processing performance of the local implementation.

### 3. Local Dual-Zone Simulation

- Uses Docker Compose to run the authentication services and Redis instances.
- NGINX distributes incoming requests between the two application instances.
- Redis replication is used to simulate shared authentication state across the two zones.

### 4. Load and Failover Testing

The repository includes Grafana k6 scripts covering six experimental scenarios:

| Scenario | Experiment | Objective |
|---|---|---|
| T1 | Baseline | Establish normal system performance |
| T2 | Scaling | Observe behaviour under increasing load |
| T3 | Saturation | Identify performance limits |
| T4 | Failover | Evaluate service continuity during failure |
| T5 | TTL Expiry | Verify OTP expiration |
| T6 | Replay Protection | Verify duplicate signed-request rejection |

The k6 scripts are part of the experimental suite; individual execution status and measured results are documented in the test-results files.

### 5. AWS Multi-AZ Experiments

The live AWS deployment is used to examine:

- Application availability across two Availability Zones.
- ALB health checks and target health transitions.
- Traffic redirection after application failure.
- Redis replica promotion after primary failure.
- Authentication behaviour during and after failover.
- Cloud deployment performance and latency.

Detailed empirical measurements and experiment outputs are maintained in [`prototype/results/`](./prototype/results/).

---

## 🛠️ Technology Stack

| Category | Technologies |
|---|---|
| Backend | Node.js 20, Express 4 |
| Load Balancing | AWS Application Load Balancer, NGINX 1.25 |
| Distributed Cache | Redis 7 |
| Containerization | Docker, Docker Compose |
| Cloud Infrastructure | AWS EC2, VPC, Availability Zones, ALB |
| Load Testing | Grafana k6 |
| Security | HMAC-SHA256, SHA-256, AES-256-GCM, Verhoeff |
| Testing | Node.js Test Runner |
| Monitoring | Custom health endpoints, chaos-monitoring scripts |
| Scripting | JavaScript, Shell |

---

## 📁 Repository Structure

```text
.
├── Group44.pdf
├── Week1_Aadhaar_Case_Study_Summary.docx
├── Group_44_Week2_Aadhaar_Report.pdf
├── Group_44_Week3_Results_Addon.pdf
├── Group_44_Week4_Final_Report.pdf
│
├── create_week1_docx.py
├── PROJECT_HANDBOOK.md
├── PROJECT_GUIDE.md
├── Project_Instructions.md
├── IT457_Project_ Doc.pdf
├── IT457 Project Implementation Guide.pdf
├── project_title.txt
│
├── papers/
│   ├── UIDAI_Aadhaar_Technology_Architecture_2014.pdf
│   ├── CAG_Report_24_of_2021_UIDAI_Performance_Audit.pdf
│   ├── UIDAI_Role_of_Biometric_Technology_in_Aadhaar_Enrolment_2012.pdf
│   └── Tiwari_et_al_Indias_Aadhaar_Biometric_ID_Structure_Security_Vulnerabilities.pdf
│
└── prototype/
    ├── auth-service/
    │   └── Stateless Node.js / Express authentication service
    │
    ├── nginx/
    │   └── NGINX load balancer and optional TLS configuration
    │
    ├── k6/
    │   └── Grafana k6 load and failover scenarios (T1–T6)
    │
    ├── scripts/
    │   └── Deployment, smoke testing, chaos monitoring and local simulations
    │
    ├── results/
    │   └── Benchmark reports, test outputs and chaos timelines
    │
    ├── docker-compose.yml
    ├── docker-compose.az.yml
    ├── docker-compose.prod.yml
    ├── docker-compose.tls.yml
    └── DEPLOYMENT.md
```

---

## 🚀 Running the Local Prototype

The local prototype can be used to explore the authentication workflow and simulate the dual-zone architecture.

### Prerequisites

- Docker
- Docker Compose
- Node.js 20 or later

### Start the Local Environment

From the prototype directory:

```bash
cd prototype
docker compose up --build
```

This starts the local dual-zone simulation using the configured Docker Compose services.

### Access the Application

Open:

```text
http://localhost/
```

### Check Service Health

```text
http://localhost/health
```

### Stop the Local Environment

```bash
docker compose down
```

For the AWS deployment, per-AZ deployment and TLS configuration, refer to the deployment guide:

[`prototype/DEPLOYMENT.md`](./prototype/DEPLOYMENT.md)

---

## 📚 Primary Research & References

The case study is supported by the following archived research and technical documents in [`papers/`](./papers):

1. **UIDAI Technology Architecture Whitepaper (2014):** Architectural principles, distributed storage and API design.
2. **CAG Performance Audit Report No. 24 of 2021:** Infrastructure, expenditure, service-level compliance and operational governance.
3. **UIDAI Biometrics Committee Report (2012):** Biometric modalities and the role of biometric technology in Aadhaar enrollment.
4. **Tiwari et al. — India's Aadhaar Biometric ID: Structure, Security & Vulnerabilities:** Academic analysis of CIDR, Registered Devices and security architecture.

These documents provide the research foundation for understanding the architecture and designing the scaled-down practical implementation.

---

## ⚠️ Scope & Limitations

This project is an academic case study and scaled-down implementation inspired by UIDAI's distributed architecture. It is not a production implementation of Aadhaar.

The following limitations apply:

- The prototype implements a simplified 1:1 OTP authentication workflow.
- Production biometric authentication and 1:N biometric deduplication are outside the implementation scope.
- SMS delivery is simulated in demo mode.
- HMAC and AES-GCM demonstrate application-level cryptographic protection and do not replace production HSM-backed key management.
- The prototype uses Redis replication, which is asynchronous and may result in loss of recent writes during failure.
- The audit logger uses an asynchronous application-level mechanism rather than a durable production message queue.
- The prototype demonstrates high-availability concepts at a smaller scale and does not reproduce UIDAI's complete production infrastructure.

---

## 🗓️ Project Milestones

| Week | Milestone | Status |
|---|---|---|
| Week 1 | Literature survey, architecture research and one-page milestone summary | Completed |
| Week 2 | Detailed architecture analysis, component diagrams and implementation blueprint | Completed |
| Week 3 | Authentication microservice, local experiments, benchmark and AWS empirical evaluation | Completed |
| Week 4 | Live AWS Multi-AZ deployment, chaos/failover demonstration and consolidated report | Completed |
| Week 5 | Project viva and final defense | Upcoming |

### Submission Documents

- [Week 1 Milestone — Group44.pdf](./Group44.pdf)
- [Week 2 Architecture Report](./Group_44_Week2_Aadhaar_Report.pdf)
- [Week 3 Experimental Results Add-on](./Group_44_Week3_Results_Addon.pdf)
- [Week 4 Final Consolidated Report](./Group_44_Week4_Final_Report.pdf)

---

## 🎯 Project Objective

The central objective of this project is to understand how distributed cloud and data-center architectures support large-scale identity systems, and to demonstrate key high-availability principles through a practical authentication service.

The implementation brings together:

- Secure request authentication.
- Distributed caching and state replication.
- Load balancing across multiple application instances.
- Health monitoring and failure detection.
- Automated failover and recovery.
- Performance and reliability evaluation.

**The project connects the architectural study of a national-scale digital identity platform with a practical demonstration of distributed systems, cloud infrastructure and high availability.**

---

**Course:** IT457 – Cloud Computing  
**Project Theme:** Government & Public Digital Infrastructure  
**Group:** 44
