import os
import docx
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

def set_cell_margins(cell, top=50, bottom=50, left=70, right=70):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m, val in [('top', top), ('bottom', bottom), ('left', left), ('right', right)]:
        node = OxmlElement(f'w:{m}')
        node.set(qn('w:w'), str(val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)

def set_cell_background(cell, hex_color):
    shading_xml = f'<w:shd {nsdecls("w")} w:fill="{hex_color}"/>'
    cell._tc.get_or_add_tcPr().append(parse_xml(shading_xml))

def set_table_borders(table, color="D1D5DB", sz="4", val="single"):
    tblPr = table._tbl.tblPr
    borders_xml = f'''
    <w:tblBorders {nsdecls("w")}>
        <w:top w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
        <w:bottom w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
        <w:left w:val="none"/>
        <w:right w:val="none"/>
        <w:insideH w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
        <w:insideV w:val="none"/>
    </w:tblBorders>
    '''
    tblPr.append(parse_xml(borders_xml))

def build_docx(filename="Week1_Aadhaar_Case_Study_Summary.docx"):
    doc = Document()
    
    # Page setup - A4 with precise 0.45 in margins to guarantee single-page fit
    for section in doc.sections:
        section.page_width = Inches(8.27)   # A4
        section.page_height = Inches(11.69) # A4
        section.top_margin = Inches(0.42)
        section.bottom_margin = Inches(0.42)
        section.left_margin = Inches(0.48)
        section.right_margin = Inches(0.48)
    
    NAVY = RGBColor(15, 44, 89)       # #0F2C59
    SLATE = RGBColor(37, 99, 235)     # #2563EB
    DARK = RGBColor(30, 41, 59)        # #1E293B
    
    # -------------------------------------------------------------
    # Title & Header Block
    # -------------------------------------------------------------
    title_p = doc.add_paragraph()
    title_p.paragraph_format.space_before = Pt(0)
    title_p.paragraph_format.space_after = Pt(1)
    r_title = title_p.add_run("IT457: Cloud Computing — Case Study Project (Week 1 Submission)")
    r_title.bold = True
    r_title.font.name = "Arial"
    r_title.font.size = Pt(13)
    r_title.font.color.rgb = NAVY
    
    sub_p = doc.add_paragraph()
    sub_p.paragraph_format.space_before = Pt(0)
    sub_p.paragraph_format.space_after = Pt(3)
    r_sub = sub_p.add_run("Topic: Aadhaar (UIDAI) — Biometric ID System, Cloud & Data-Center Architecture at National Scale")
    r_sub.bold = True
    r_sub.font.name = "Arial"
    r_sub.font.size = Pt(10)
    r_sub.font.color.rgb = SLATE
    
    # Meta / Info Table
    info_table = doc.add_table(rows=1, cols=3)
    info_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    info_table.autofit = False
    
    col_widths = [Inches(2.4), Inches(2.55), Inches(2.36)]
    info_data = [
        [("Deliverable: ", True), ("Week 1 Milestone Summary", False)],
        [("Theme: ", True), ("Govt & Public Digital Infrastructure", False)],
        [("Group ID / Author: ", True), ("[Insert Group ID / Name / Roll No.]", False)]
    ]
    
    for i, cell in enumerate(info_table.rows[0].cells):
        cell.width = col_widths[i]
        set_cell_background(cell, "F1F5F9")
        set_cell_margins(cell, top=40, bottom=40, left=60, right=60)
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        for text, bold in info_data[i]:
            run = p.add_run(text)
            run.font.name = "Arial"
            run.font.size = Pt(8.5)
            run.bold = bold
            run.font.color.rgb = DARK
            
    def add_sec_header(text):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after = Pt(2.5)
        r = p.add_run(text)
        r.bold = True
        r.font.name = "Arial"
        r.font.size = Pt(10)
        r.font.color.rgb = NAVY
        return p

    # -------------------------------------------------------------
    # 1. Primary Sources & Literature Survey
    # -------------------------------------------------------------
    add_sec_header("1. Primary Sources & Literature Survey (Full PDFs Retrieved & Archived in Workspace)")
    
    src_table = doc.add_table(rows=5, cols=4)
    src_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(src_table, color="CBD5E1", sz="4")
    
    col_w = [Inches(2.3), Inches(1.2), Inches(2.81), Inches(1.0)]
    headers = ["Document Title & Authors", "Source Type", "Key Architectural Findings Extracted", "Archived PDF"]
    
    for i, title in enumerate(headers):
        cell = src_table.rows[0].cells[i]
        cell.width = col_w[i]
        set_cell_background(cell, "0F2C59")
        set_cell_margins(cell, top=45, bottom=45, left=50, right=50)
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(title)
        r.bold = True
        r.font.name = "Arial"
        r.font.size = Pt(8)
        r.font.color.rgb = RGBColor(255, 255, 255)
        
    papers_data = [
        ("Aadhaar Technology & Architecture: Principles, Design & Best Practices\n(UIDAI Tech Centre, Govt. of India)",
         "Official Technical Whitepaper (167 pp)",
         "Twin active-active data centers (Hebbal & Manesar); open-source distributed stack (Hadoop/HDFS, HBase, Cassandra, MySQL, RabbitMQ); horizontal scaling; vendor-neutral ABIS APIs.",
         "UIDAI_Aadhaar_Technology_Architecture_2014.pdf"),
         
        ("Performance Audit on Functioning of UIDAI (Report No. 24 of 2021)\n(Comptroller & Auditor General of India)",
         "Constitutional Audit Report (120+ pp)",
         "Empirical data on capital/operational expenditures, infrastructure SLA compliance, deduplication accuracy, data center facility contracts, and IT system security governance.",
         "CAG_Report_24_of_2021_UIDAI_Performance_Audit.pdf"),
         
        ("Role of Biometric Technology in Aadhaar Enrollment\n(UIDAI Biometrics Committee)",
         "Empirical System Report (23 pp)",
         "Multi-modal biometric rationale (10 fingerprints + 2 irises + face photo) counteracting manual labor wear; client quality thresholds; 1:N deduplication performance at 84M+ scale.",
         "UIDAI_Role_of_Biometric_Technology_in_Aadhaar_Enrolment_2012.pdf"),
         
        ("India’s 'Aadhaar' Biometric ID: Structure, Security & Vulnerabilities\n(Tiwari, Agarwal et al. — JHU, MSR, Ashoka)",
         "Academic Peer-Reviewed Paper (26 pp)",
         "Independent architectural analysis of Central Identities Data Repository (CIDR), Registered Devices (RD) PKI encryption pipeline, stateless Auth API protocols, and threat vectors.",
         "Tiwari_et_al_Indias_Aadhaar_Biometric_ID_Structure_Security_Vulnerabilities.pdf")
    ]
    
    for row_idx, data in enumerate(papers_data, start=1):
        for col_idx, text in enumerate(data):
            cell = src_table.rows[row_idx].cells[col_idx]
            cell.width = col_w[col_idx]
            if row_idx % 2 == 0:
                set_cell_background(cell, "F8FAFC")
            set_cell_margins(cell, top=35, bottom=35, left=50, right=50)
            p = cell.paragraphs[0]
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            r = p.add_run(text)
            r.font.name = "Arial"
            r.font.size = Pt(7.3)
            r.font.color.rgb = DARK

    # -------------------------------------------------------------
    # 2. Case Study Salient Points
    # -------------------------------------------------------------
    add_sec_header("2. Case Study Salient Points: Problem, Architecture & Outcomes")
    
    salient_items = [
        ("Problem Statement & National Scale: ",
         "Engineering a foundational digital ID system for 1.4+ billion residents requiring two distinct processing workloads: "
         "(a) Enrollment (1:N Deduplication): Compute-intensive matching of incoming biometrics against trillions of stored feature vectors to guarantee absolute uniqueness without ghost identities; "
         "(b) Real-Time Authentication (1:1 Verification): Sub-second verification (<200 ms latency) handling 80M–100M daily transactions (e-KYC, biometric auth, OTP) across diverse, erratic network conditions."),
         
        ("Distributed Cloud & Data-Center Architecture: ",
         "UIDAI avoided proprietary vendor lock-in by designing a private cloud on commodity Linux servers across dual active-active sites: "
         "Primary Data Centre (PDC) at Hebbal (Bengaluru) and Disaster Recovery Centre (DRC) at Manesar (Gurugram). "
         "Core architectural pillars include: (i) Tiered Distributed Storage: HDFS for bulk raw biometric packets, HBase/Cassandra for high-throughput columnar lookups, sharded MySQL for transactional state; "
         "(ii) Parallel Biometric Search (ABIS): Multi-engine deduplication orchestrating three vendor algorithms in parallel; "
         "(iii) Zero-Trust Security & Cryptography: Asymmetric public-key encryption at capture devices (Registered Device framework), boolean Yes/No responses (no biometric/PII leakage), and Hardware Security Modules (HSMs) for key management."),
         
        ("Financial & Socioeconomic Outcomes: ",
         "Drove enrollment unit costs down to <$1 per identity (vs. $5–$15 internationally). Catalyzed the JAM trinity (Jan Dhan-Aadhaar-Mobile) and Direct Benefit Transfer (DBT), "
         "preventing an estimated billions of dollars in ghost beneficiary leakages while forming the foundational Presenceless Layer of India Stack.")
    ]
    
    for title, desc in salient_items:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.left_indent = Inches(0.12)
        r_t = p.add_run("• " + title)
        r_t.bold = True
        r_t.font.name = "Arial"
        r_t.font.size = Pt(8)
        r_t.font.color.rgb = DARK
        r_d = p.add_run(desc)
        r_d.font.name = "Arial"
        r_d.font.size = Pt(8)
        r_d.font.color.rgb = DARK

    # -------------------------------------------------------------
    # 3. Practical Hands-On Exercise Plan (Weeks 2–4 Preview)
    # -------------------------------------------------------------
    add_sec_header("3. Practical Exercise Plan: Scaled-Down High-Availability Authentication Service")
    
    ex_items = [
        ("Architecture Design: ",
         "Architect a multi-region, high-availability identity authentication system replicating the UIDAI 1:1 Auth pipeline. "
         "A global reverse proxy/load balancer will distribute incoming requests across two simulated regions (Primary & Secondary Failover)."),
         
        ("Component Implementation & Stack: ",
         "Build a containerized stateless Authentication API service (Node.js/FastAPI/Go) integrated with: "
         "(a) In-memory distributed caching (Redis) for rapid sub-millisecond UID token lookups; "
         "(b) Simulated cryptographic verification module verifying edge-encrypted biometric hashes and OTP signatures; "
         "(c) Asynchronous logging and audit queue via Redis/RabbitMQ."),
         
        ("Experimental Rigor & Deliverables: ",
         "Deploy the service live on cloud instances (e.g., AWS/GCP/Render) with a public URL. Conduct rigorous load testing using k6/Locust to benchmark latency percentiles (p50, p95, p99), "
         "throughput limits (RPS), auto-scaling behavior under traffic spikes, and generate an empirical cloud cost model.")
    ]
    
    for title, desc in ex_items:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.left_indent = Inches(0.12)
        r_t = p.add_run("• " + title)
        r_t.bold = True
        r_t.font.name = "Arial"
        r_t.font.size = Pt(8)
        r_t.font.color.rgb = DARK
        r_d = p.add_run(desc)
        r_d.font.name = "Arial"
        r_d.font.size = Pt(8)
        r_d.font.color.rgb = DARK
        
    doc.save(filename)
    print(f"Successfully generated {filename}")

if __name__ == "__main__":
    build_docx()
