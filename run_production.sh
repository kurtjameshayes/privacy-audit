#!/bin/bash
# Run from project root. Installs deps if needed, then starts gunicorn.
# Use 1 worker for 1GB droplets (avoids OOM); use -w 2 for 2GB+, -w 4 for 4GB+.
set -e
cd "$(dirname "$0")"

if [ -d .venv ]; then
  source .venv/bin/activate
fi

pip install -q -r backend/requirements.txt
mkdir -p logs
exec gunicorn -w 1 -b 0.0.0.0:5120 --timeout 120 \
  --access-logfile logs/access.log \
  --error-logfile logs/error.log \
  --capture-output \
  backend.app:app
