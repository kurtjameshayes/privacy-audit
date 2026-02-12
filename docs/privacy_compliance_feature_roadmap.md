# Privacy Compliance Feature Plan (No Human Assistance)

Research on leading privacy compliance platforms (DataGrail, OneTrust, BigID, TrustArc, SECURITI, Osano) is compared to Privacy Audit Studio's current capabilities. The plan proposes only automated (zero-human-touch) feature additions, with each item classified by whether it requires more data, more technology, or both.

---

## 1. Competitor product summary

| Vendor        | Automated products / services (no human required)                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **DataGrail** | Data mapping/discovery (AI-recommended), automated DSR fulfillment, consent enforcement, pre-populated risk assessments (DPIA/PIA/AI), ML data classification                              |
| **OneTrust**  | Consent & preference management, CMP, Privacy Operations (data flows, asset classification, risk, notices), DSR automation, DataGuidance (regulatory updates), compliance automation       |
| **BigID**     | Identity-aware data mapping, RoPA/PIA automation, DSR workflows, consent/preference management, cookie management, cross-border transfer intelligence, retention/minimization, vendor risk |
| **TrustArc**  | Individual Rights Manager (DSR), consent/preference manager, cookie consent, data mapping & risk, assessment manager (PIA, AI risk), Trust Center                                          |
| **SECURITI**  | Data discovery (Personal Data Finder), DSR fulfillment bots, predefined compliance tests, auto remediation guidance, compliance reports, Securiti Copilot (regulatory Q&A), Privacy Center |
| **Osano**     | Cookie consent (50+ countries), DSAR automation, privacy assessments (templates), data mapping, vendor risk, consent hub                                                                   |

Common themes: **policy/document analysis**, **DSR/request workflows**, **consent/cookie management**, **data mapping**, **risk assessments (DPIA/PIA)**, **regulatory change/drift**, **audit trail and reporting**.

---

## 2. Our application's current features

**Implemented (backend + partial UI):**

- **Ingestion**: Gather → Crawl (Firecrawl) → Save policy/statute; Parse-LLM + Save-Parsed for chunks ([backend/app.py](../backend/app.py))
- **Vector index/search**: Proxied to upstream ([backend/app.py](../backend/app.py))
- **Policy–statute compliance** (single jurisdiction): Upstream API; UI shows sections (compliant / non_compliant / neither), remediation, filters ([frontend/src/App.tsx](../frontend/src/App.tsx))
- **Applicability**: Backend only – SLM infers applicable jurisdictions ([backend/compliance/engine.py](../backend/compliance/engine.py), [backend/app.py](../backend/app.py) `/api/compliance/applicability`)
- **Gap analysis**: Backend only – policy vs statute chunks → missing/addressed/conflict; optional save to `compliance_results` ([backend/app.py](../backend/app.py) `/api/compliance/gap-analysis`)
- **Multi-jurisdictional**: Backend only – strictest common denominator, conflict detection ([backend/app.py](../backend/app.py) `/api/compliance/multi-jurisdictional`)
- **Privacy Health Score**: Backend only – 0–100, breakdown by jurisdiction/category; optional save ([backend/app.py](../backend/app.py) `/api/compliance/health-score`)
- **Regulatory drift**: Backend only – re-run analysis, diff vs last result, write to `compliance_alerts` ([backend/app.py](../backend/app.py) `/api/compliance/drift-check`)

**Spec'd but not yet built:** Statute–policy citation extraction, full audit trail/versioning, scheduled/event-driven pipelines ([compliance_suite_functional_spec.md](compliance_suite_functional_spec.md) §6–8).

---

## 3. Gap vs competitors (automated only)

- **Data mapping / DSR fulfillment / consent/cookie runtime**: Competitors integrate with live systems and data stores. We focus on **policy and statute text**; we do not have customer data stores or website runtime. So "full" DSR fulfillment, consent enforcement, and data mapping are out of scope for this app without major new data and integrations.
- **Policy + statute analysis**: We already have gap analysis, multi-jurisdictional, health score, drift. Competitors offer **reports**, **dashboards**, **audit trail**, and **regulatory change** visibility – we have the engines but limited UI and no export.
- **Risk assessments**: Competitors offer **pre-populated DPIA/PIA/AI assessments**. We can do something analogous by generating structured risk/assessment content from policy + statute chunks via SLM (no human in the loop).
- **Regulatory updates**: We have **drift detection** when the statute index changes; we do not have a "DataGuidance"-style curated news feed (that would be human-curated content).

---

## 4. Proposed features (no human assistance)

Only features that can be delivered with **SLM + heuristics + existing or clearly defined new data** are included. For each, the plan states whether we need **more data**, **more technology**, or **both**.

### 4.1 Expose existing compliance engines in the UI

**What:** Let users run and view results for **Applicability**, **Gap analysis**, **Multi-jurisdictional**, **Health score**, and **Drift check** from the app (not only the single-jurisdiction "policy–statute compliance" and not only via API).

**Why:** Aligns with competitor "single pane" for compliance; we already have the APIs.

**More data?** No. **More technology?** Yes (frontend: new screens/flows, call existing `/api/compliance/*` endpoints, display JSON results in tables/cards/expandable sections).

---

### 4.2 Compliance report export (Markdown / PDF)

**What:** One-click export of current run: gap list (missing/addressed/conflict), health score and breakdown, optional multi-jurisdictional summary, in Markdown and/or PDF.

**Why:** Competitors offer downloadable reports for audits and internal use.

**More data?** No. **More technology?** Yes (report generator: template + data → Markdown; optional PDF renderer or print CSS).

---

### 4.3 Audit trail and versioned compliance runs

**What:** Persist every compliance run (applicability, gap, multi-jurisdictional, health score) with (policy_id, statute index version or timestamp, run timestamp). Queryable history and, where applicable, "score over time" per policy.

**Why:** Matches competitor "audit-ready" and "governance trail"; spec §6.3.

**More data?** No new source data; we need **structured run metadata** (e.g. statute_version or index timestamp) stored with each run. **More technology?** Yes (backend: consistent write to `compliance_run_log` or equivalent; optional API to query history; optional UI for "history" and score trend).

---

### 4.4 Statute–policy citation extraction

**What:** For each relevant policy section, output explicit (policy excerpt, statute reference, alignment yes/no). Used as evidence for health score and gap analysis and to reduce hallucination (citation binding).

**Why:** Spec §6.2; competitors emphasize "evidence" and "citations" in compliance reports.

**More data?** No (policy + statute chunks already available). **More technology?** Yes (new SLM step + vector search: "Does this policy section cite or align with this statute?"; structured output; optional UI to show citations).

---

### 4.5 Pre-populated risk assessment (DPIA/PIA-style)

**What:** From a policy and its applicable statute chunks, use the SLM to auto-fill a risk assessment template (e.g. DPIA/PIA-style questionnaire or structured sections: processing purposes, data categories, risks, mitigations). Output structured JSON + optional report.

**Why:** Competitors offer "pre-built templates" and "AI-populated" assessments; we stay within policy + statute only.

**More data?** Optional: a **small template library** (e.g. standard DPIA/PIA section headings and question sets) to improve consistency. **More technology?** Yes (SLM prompts to map policy + statute to template fields; template engine; optional export).

---

### 4.6 Regulatory drift dashboard

**What:** UI to list and filter **regulatory drift alerts** from `compliance_alerts` (e.g. by policy, company, jurisdiction, date). Show new gaps, score delta, and link to the policy/run.

**Why:** Competitors surface "new regulations" and "what changed"; we already produce drift alerts.

**More data?** No (alerts already written by drift-check). **More technology?** Yes (backend: read API for `compliance_alerts` with filters; frontend: drift dashboard page).

---

### 4.7 Scheduled and event-driven compliance pipelines

**What:** Run applicability → gap → multi-jurisdictional → health score → store result on a schedule (e.g. nightly/weekly) and, when statute index is updated, run drift-check and write alerts. No UI required for the pipeline itself.

**Why:** Spec §6.4; competitors offer "automated" and "continuous" compliance.

**More data?** No. **More technology?** Yes (scheduler: cron or internal job runner; optional webhook or "index updated" trigger; orchestration that calls existing endpoints and persists results).

---

### 4.8 Multi-jurisdiction flow in UI (applicability → gap/score)

**What:** In the UI: run Applicability for a policy, then offer "Run gap analysis" and "Run health score" for the returned jurisdictions (pre-fill `applicable_jurisdictions`). Show which jurisdictions were inferred and allow override.

**Why:** Reduces manual steps and matches "multi-jurisdiction" workflows in competitor UIs.

**More data?** No. **More technology?** Yes (frontend: chain applicability → gap/score with applicability result; optional jurisdiction selector/override).

---

## 5. Summary: data vs technology

| Feature                                  | More data?         | More technology? |
| ---------------------------------------- | ------------------ | ---------------- |
| Expose compliance engines in UI          | No                 | Yes              |
| Compliance report export (MD/PDF)        | No                 | Yes              |
| Audit trail / versioned runs             | Run metadata only  | Yes              |
| Statute–policy citation extraction       | No                 | Yes              |
| Pre-populated risk assessment (DPIA/PIA) | Optional templates | Yes              |
| Regulatory drift dashboard               | No                 | Yes              |
| Scheduled/event-driven pipelines         | No                 | Yes              |
| Multi-jurisdiction flow in UI            | No                 | Yes              |

**Conclusion:** All proposed features are achievable without human-in-the-loop. None require new *raw* data sources beyond optional template library for §4.5. All require additional technology (frontend, backend, and/or new SLM/vector steps).

---

## 6. Suggested implementation order

1. **Expose existing engines in UI** (§4.1) – immediate value, unblocks use of gap/score/drift.
2. **Multi-jurisdiction flow in UI** (§4.8) – small extension of §4.1, improves UX.
3. **Regulatory drift dashboard** (§4.6) – makes existing drift-check output visible.
4. **Audit trail / versioned runs** (§4.3) – enables trend and reproducibility.
5. **Compliance report export** (§4.2) – high value for audits.
6. **Statute–policy citation extraction** (§4.4) – improves rigor and explainability.
7. **Scheduled/event-driven pipelines** (§4.7) – full automation.
8. **Pre-populated risk assessment** (§4.5) – differentiator; can follow once templates are defined.
