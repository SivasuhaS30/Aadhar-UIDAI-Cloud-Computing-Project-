# Aadhaar (UIDAI) — Cloud & Data-Center Architecture at National Scale

**Course:** IT457 – Cloud Computing  
**Theme:** Government & Public Digital Infrastructure  
**Topic:** Aadhaar (UIDAI) Biometric ID System, Cloud/Data-Center Architecture at National Scale  

## 🌐 Live Multi-AZ AWS Deployment & Chaos Failover Proof

- **Live Public ALB Endpoint:** [`http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/`](http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/) (AWS Sydney `ap-southeast-2a` + `ap-southeast-2b` behind Application Load Balancer `aadhaar-alb`)
- **Live Health Check:** [`http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/health`](http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/health)
- **Live Multi-AZ Chaos/Failover Video:** [Google Drive Recording (Zone A Outage & Automated `REPLICAOF NO ONE` Promotion)](https://drive.google.com/file/d/1knZ0NuT9ByiJ9Jv9SY7KTEyB0pXB5Xma/view?usp=drive_link)
- **Empirical Test Results:** [`prototype/results/TEST_RESULTS.md`](./prototype/results/TEST_RESULTS.md)

---

## 📌 Project Overview
This repository contains the coursework, case study analysis, architecture blueprints, and hands-on simulation project for **IT457: Cloud Computing**.

Aadhaar is the world's largest biometric digital identity platform, serving **1.4+ billion residents** and processing **80M–100M+ real-time authentications daily**. This project evaluates the foundational cloud and data-center architecture developed by UIDAI, with a primary focus on:
1. **1:N Deduplication (Enrollment Pipeline):** Compute-intensive parallel biometric matching across trillions of vector pairs to guarantee identity uniqueness.
2. **1:1 Real-Time Authentication Pipeline:** Sub-second (<200 ms latency) verification returning boolean Yes/No responses without exposing PII or biometric vectors.
3. **Distributed Infrastructure:** Twin active-active data centers (Hebbal PDC & Manesar DRC), tiered storage (HDFS, HBase, Cassandra, MySQL), and zero-trust edge PKI security via Registered Devices (RD) and Hardware Security Modules (HSMs).
4. **Hands-On Simulation:** Designing and benchmarking a scaled-down, high-availability authentication microservice with load balancing, distributed caching, and failover simulation.

---

## 📁 Repository Structure
```text
.
├── Group44.pdf                                # Official Week 1 Milestone (1-Page PDF)
├── Week1_Aadhaar_Case_Study_Summary.docx      # Official Week 1 Milestone (DOCX)
├── Group_44_Week2_Aadhaar_Report.pdf          # Official Week 2 10-Page Case Analysis & Exercise Blueprint
├── Group_44_Week3_Results_Addon.pdf           # Official Week 3 Experiments, Latency, Scaling & Cost Add-on Report
├── Group_44_Week4_Final_Report.pdf            # Official Week 4 Final Consolidated Project Report
├── create_week1_docx.py                       # Automation script for Week 1 document generation
├── PROJECT_HANDBOOK.md                        # Crisp concept & implementation study handbook
├── PROJECT_GUIDE.md                           # Master technical & case-study reference guide
├── Project_Instructions.md                    # Course instructions & milestones
├── IT457_Project_ Doc.pdf                     # Official course case study guidelines
├── IT457 Project Implementation Guide.pdf     # Theme-wise final deliverables & Multi-AZ implementation guide
├── project_title.txt                          # Assigned topic identifier
├── papers/                                    # Archived primary research papers & audit reports
│   ├── UIDAI_Aadhaar_Technology_Architecture_2014.pdf
│   ├── CAG_Report_24_of_2021_UIDAI_Performance_Audit.pdf
│   ├── UIDAI_Role_of_Biometric_Technology_in_Aadhaar_Enrolment_2012.pdf
│   └── Tiwari_et_al_Indias_Aadhaar_Biometric_ID_Structure_Security_Vulnerabilities.pdf
└── prototype/                                 # Multi-AZ / Multi-Region 1:1 Auth Microservice (Phases 0–4 Ready)
    ├── auth-service/                          # Stateless Node.js 20 / Express 4 service, `/` UI & test suites
    ├── nginx/                                 # NGINX 1.25 load balancer & optional TLS config
    ├── k6/                                    # Grafana k6 load & failover scripts (Scenarios T1–T6)
    ├── scripts/                               # EC2 Multi-AZ/single deploy, smoke client, chaos monitor & local sims
    ├── results/                               # Saved test outputs, chaos CSV/JSON timelines & benchmark reports
    ├── docker-compose.yml                     # Single-host simulated dual-region stack (NGINX + Dual Redis)
    ├── docker-compose.az.yml                  # Per-AZ EC2 node stack (ap-south-1a / ap-south-1b behind AWS ALB)
    ├── docker-compose.prod.yml                # Production resource & logging override for AWS EC2 t3.micro
    ├── docker-compose.tls.yml                 # Optional HTTPS/TLS termination override
    └── DEPLOYMENT.md                          # AWS Multi-AZ + ALB & Single-VM deployment runbook
```

---

## 📚 Primary Research & Archived Literature
The following authoritative documents are archived in [`papers/`](./papers):
1. **UIDAI Technology Architecture Whitepaper (2014):** Official architectural principles, distributed storage stack, and API design (167 pages).
2. **CAG Performance Audit Report No. 24 of 2021:** Official expenditure, infrastructure SLA compliance, contract management, and operational metrics from the Comptroller & Auditor General of India.
3. **UIDAI Biometrics Committee Report (2012):** Empirical rationale for multimodal biometrics (10 fingerprints + 2 irises + face) and 1:N deduplication engine scaling.
4. **Tiwari et al. (Johns Hopkins / Microsoft Research / Ashoka Univ):** Academic architectural analysis of CIDR, Registered Devices, and cryptographic protocols.

---

## 🗓️ 5-Week Milestone Roadmap
- [x] **Week 1:** Primary literature survey, architecture extraction, 1-page milestone summary ([`Group44.pdf`](./Group44.pdf)).
- [x] **Week 2:** Detailed 10-page architecture analysis ([`Group_44_Week2_Aadhaar_Report.pdf`](./Group_44_Week2_Aadhaar_Report.pdf)), system component diagrams, exercise blueprint, and team role distribution.
- [x] **Week 3:** Practical implementation of scaled-down auth microservice in [`prototype/`](./prototype), local verification (`12/12` unit/integration + `1174.7 req/s` loopback benchmark), live AWS Multi-AZ empirical latency/failover experiments, AWS cost analysis, and [`Group_44_Week3_Results_Addon.pdf`](./Group_44_Week3_Results_Addon.pdf).
- [x] **Week 4:** Live AWS Multi-AZ deployment (`ap-southeast-2a` & `ap-southeast-2b` behind `aadhaar-alb`) at [`http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/`](http://aadhaar-alb-1253686032.ap-southeast-2.elb.amazonaws.com/), live Chaos/Failover video proof, and [`Group_44_Week4_Final_Report.pdf`](./Group_44_Week4_Final_Report.pdf).
- [ ] **Week 5:** Project VIVA defense.
