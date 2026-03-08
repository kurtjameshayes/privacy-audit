# Privacy Audit Studio — Functional Description (Figma-Ready)

**Purpose:** User-facing functions for design/prototyping. Focus: *what users can do*, not UI specifics.

**Overview:** Gather, index, and compare privacy policies against statutory standards. Flow: **Gather → Index → Compare**.

---

## 1. Gather
- Search for policies (by org name) or statutes (by name/jurisdiction); view results with scores/URLs.
- Acquire content: crawl from search result, enter direct URL, or upload file (PDF/TXT/HTML); view extracted text before saving.
- Save to collection with company name (policies) or jurisdiction (statutes).

## 2. Documents
- Browse policies/statutes; search by title, company, jurisdiction, URL, text; see workflow status (Gathered, Parsed, Indexed).
- Parse: segment into chunks, review, save to vector index; optional parse instructions.
- View chunks. Policy actions: Run compliance, Extract citations, Generate report, Risk assessment. *Requires Gathered, Parsed, Indexed.*

## 3. Compliance
- Select policy; check readiness; set jurisdictions (manual or suggest from policy).
- Run engines: Applicability, Gap analysis, Health score (0–100), Multi-jurisdictional, Policy-statute compliance.
- View results: gaps (filterable), score breakdown, requirements table, section alignment with remediation.

## 4. Alerts
- Filter drift alerts by policy, company, jurisdiction, date; browse paginated list.

## 5. Runs
- Filter by policy, date range, job type; browse table (Run ID, Policy, Company, Status, Score, Summary, Types).
- View detail: parameters, gap analysis, score assessment; re-run, download JSON/report, delete.

## 6. Reports
- Select policy; choose format (MD/PDF), source (stored or run now), inclusions (gap, health score, multi-jurisdictional); generate, preview, download.

## 7. Extract Citations
- Run extraction on policy; view summary (aligned/not aligned/total) and citation list.

## 8. Risk Assessment
- Run DPIA/PIA-style assessment; select template; include report; view report and structured data.

---

**Cross-cutting:** Workflow gating (Gathered→Parsed→Indexed); top-level nav; context passing (Documents→Compliance/Reports); error handling.

**Personas:** Compliance analyst, Legal/Privacy lead, Researcher.
