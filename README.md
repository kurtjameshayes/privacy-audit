# privacy-audit

## Overview
Privacy Audit Studio gathers published privacy policies and statutes, crawls
their full text, and prepares sources for downstream compliance analysis.

The Gather feature is implemented with a Flask API proxy and a TypeScript
frontend that calls `/api/gather`, `/api/crawl`, and `/api/save-policy`.

## Project structure
- `backend/` Flask API proxy for Web Gather endpoints.
- `frontend/` React + TypeScript UI (Vite).

## Setup
1. Copy `.env.example` to `.env` and set `FIRECRAWL_API_KEY` and
   `GATHER_API_BASE_URL` (the Web Gather API base URL).
2. Install backend dependencies:
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r backend/requirements.txt
   python backend/app.py
   ```
3. Install frontend dependencies:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

The Vite dev server proxies `/api` calls to the Flask API on port 5000. Build
the frontend with `npm run build` to serve static assets from Flask.