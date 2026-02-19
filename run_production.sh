#!/bin/bash
# Run from project root. Installs deps if needed, then starts gunicorn.
# Uses 2 workers for low-memory servers (1GB); use -w 4 for 2GB+.
set -e
cd "$(dirname "$0")"

if [ -d .venv ]; then
  source .venv/bin/activate
fi

pip install -q -r backend/requirements.txt
exec gunicorn -w 2 -b 0.0.0.0:5120 --timeout 120 backend.app:app
