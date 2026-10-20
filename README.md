# Aadhaar (UIDAI) — Cloud & Data-Center Architecture at National Scale

**Course:** IT457 – Cloud Computing  
**Theme:** Government & Public Digital Infrastructure  
**Topic:** Aadhaar (UIDAI) Biometric ID System, Cloud/Data-Center Architecture at National Scale  

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
├── Week1_Aadhaar_Case_Study_Summary.docx    # Official Week 1 Milestone (DOCX)
├── Week1_Aadhaar_Case_Study_Summary.pdf     # Official Week 1 Milestone (1-Page PDF)
├── create_week1_docx.py                     # Automation script for document generation
├── papers/                                  # Archived primary research papers & audit reports
│   ├── UIDAI_Aadhaar_Technology_Architecture_2014.pdf
│   ├── CAG_Report_24_of_2021_UIDAI_Performance_Audit.pdf
│   ├── UIDAI_Role_of_Biometric_Technology_in_Aadhaar_Enrolment_2012.pdf
│   └── Tiwari_et_al_Indias_Aadhaar_Biometric_ID_Structure_Security_Vulnerabilities.pdf
├── Project_Instructions.md                  # Course instructions & milestones
├── IT457_Project_ Doc.pdf                   # Official course case study guidelines
├── project_title.txt                        # Assigned topic identifier
└── README.md                                # Project documentation
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
- [x] **Week 1:** Primary literature survey, architecture extraction, 1-page milestone summary.
- [ ] **Week 2:** Detailed 10-page architecture analysis, system component diagrams, exercise blueprint, and team role distribution.
- [ ] **Week 3:** Practical implementation of scaled-down auth microservice; load testing (k6/Locust) measuring latency, scaling behavior, and cost.
- [ ] **Week 4:** System hardening, live cloud deployment with public URL, final report compilation.
- [ ] **Week 5:** Project VIVA defense.
