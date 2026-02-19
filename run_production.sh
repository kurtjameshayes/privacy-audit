#!/bin/bash
# Run from project root. Installs deps if needed, then starts gunicorn.
set -e
cd "$(dirname "$0")"

if [ -d .venv ]; then
  source .venv/bin/activate
fi

pip install -q -r backend/requirements.txt
exec gunicorn -w 4 -b 0.0.0.0:5120 --timeout 120 backend.app:app
