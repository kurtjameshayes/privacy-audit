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
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r backend/requirements.txt
   ```
3. Install frontend dependencies:
   ```bash
   cd frontend
   npm install
   ```

## Running the app

**Start both services** (in separate terminals):

1. **Backend** (Flask API on port 5120):
   ```bash
   python backend/app.py
   ```

2. **Frontend** (Vite dev server on port 5173):
   ```bash
   cd frontend
   npm run dev
   ```

The Vite dev server proxies `/api` calls to the Flask API on port 5120. Build
the frontend with `npm run build` to serve static assets from Flask.

## Production deployment

1. **Install Python dependencies** (required before starting the app):
   ```bash
   cd /path/to/privacy-audit
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r backend/requirements.txt
   ```
   On Ubuntu, if venv fails: `sudo apt install python3-venv`

2. **Build the frontend** (on headless servers, use `build:headless`; requires xvfb):
   ```bash
   cd frontend && npm install && npm run build:headless
   ```
   If xvfb is not installed: `sudo apt install xvfb`

3. **Start the app** (from project root):
   ```bash
   ./run_production.sh
   ```
   Or manually:
   ```bash
   source .venv/bin/activate
   gunicorn -w 4 -b 0.0.0.0:5120 --timeout 120 backend.app:app
   ```