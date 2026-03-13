# Frontend Functional Specification

## Overview

This document describes the functions available to users of the Privacy Audit Studio frontend. It specifies what the user can do, not how the interface presents these capabilities.

---

## 1. Document Acquisition (Gather)

### Search for Sources
- Search for corporate privacy policies by natural-language prompt
- Search for privacy statutes and regulations by natural-language prompt

### Direct Ingestion
- Crawl a document from a URL
- Upload a document from a local file (PDF, TXT, or HTML)

### Review and Save
- Inspect crawled or uploaded content before saving
- Save ingested content as a policy (with associated company name) or as a statute (with associated jurisdiction)
- Copy error messages to the clipboard when operations fail

---

## 2. Document Library (Documents)

### Browse and Filter
- View the collection of saved policies and statutes
- Switch between policy view and statute view
- Search or filter documents by title, company, jurisdiction, description, URL, query, or full-text content
- Refresh the document list

### Document Workflow Status
- See whether each document is in Gathered, Parsed, or Indexed state
- Understand readiness for downstream compliance operations

### Document Actions
- Navigate to compliance analysis with a policy pre-selected
- Extract citations between statutes and policies
- Navigate to report generation with a policy pre-selected
- Run a risk assessment (DPIA/PIA-style) on a policy, optionally using a template and optionally producing a report
- View and manage parsed chunks for a document

---

## 3. Document Parsing and Indexing

### Parse
- Run parsing on a document to produce policy subsections or statute chunks
- Provide optional custom parse instructions for policies
- View the full source text before parsing

### Chunk Management
- Include or exclude individual parsed sections
- Save the selected chunks to persist the parse result
- Reset parse state to start over

### Index
- Run the subsection pipeline to create a vector index for a document
- Make the document ready for compliance engines

---

## 4. Compliance Analysis

### Setup
- Select a policy to analyze
- Specify jurisdictions (comma-separated, e.g., CA, VA, CO)
- Infer suggested jurisdictions from policy text

### Run Engines
- Run gap analysis (with optional row limit)
- Run health score analysis
- Run multi-jurisdictional analysis (requires jurisdictions)
- Run policy-statute compliance analysis for a single jurisdiction

### View Results
- Filter gap analysis results by addressed, partial, ambiguous, missing, or conflict
- Expand individual result items for detail
- View health score with component breakdown
- View multi-jurisdictional results (strictest common denominator, conflicts)
- View policy-statute results (compliant, non-compliant, neither) with remediation suggestions and section-level detail

### Workflow Validation
- Be informed when a policy is not ready (gather, parse, or index incomplete) before running compliance

---

## 5. Regulatory Drift Alerts

### Filter Alerts
- Filter by policy document ID, company name, jurisdiction, or date range (since)
- Apply filters to fetch matching alerts

### View Alerts
- See alert ID, company, policy ID, trigger, type, jurisdictions, previous and current scores, delta, and detected date
- Paginate through alert results

---

## 6. Compliance Run History

### Filter Runs
- Filter by policy document ID, date range (since, until), or run types (comma-separated)
- Apply filters or refresh to fetch matching runs

### View Runs
- See run ID, policy ID, company, run time, status, health score, summary, and types
- Paginate through run results

### Run Detail
- Open a detail view for a selected run
- Switch between gap analysis view and raw JSON view
- Re-run gap analysis (with optional row count)
- Download run data as JSON
- Download run report as Markdown
- Delete a run

---

## 7. Report Generation

### Configure Report
- Select a policy to report on
- Choose output format (Markdown or PDF)
- Choose data source: latest stored result or run analysis now (without persisting)
- Include or exclude gap analysis, health score, and multi-jurisdictional sections
- Specify jurisdictions when using “run now” source

### Generate and Export
- Generate the report
- Preview the rendered report (Markdown)
- Download the report file

---

## 8. Navigation

- Access the Gather area (default landing)
- Access the document library
- Access compliance analysis (with optional policy pre-selection from documents)
- Access alerts
- Access run history
- Access report generation (with optional policy pre-selection from documents)

---

## Document Workflow Summary

Documents progress through: **Gathered → Parsed → Indexed**. Compliance engines and report generation require a document to be fully indexed. Actions that depend on readiness are disabled or surfaced as unavailable until the document reaches the appropriate state.
