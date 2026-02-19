#!/bin/bash
# Install privacy-audit as a systemd service.
# Run with: sudo ./scripts/install-systemd.sh
# Optional: APP_DIR=/path/to/app APP_USER=myuser WORKERS=2 sudo ./scripts/install-systemd.sh
set -e

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
APP_USER="${APP_USER:-$(logname 2>/dev/null || echo "devuser")}"
WORKERS="${WORKERS:-1}"
SERVICE_NAME="privacy-audit"
VENV_BIN="${APP_DIR}/.venv/bin/gunicorn"
ENV_FILE="${APP_DIR}/.env"

# Validate
if [ ! -d "$APP_DIR" ]; then
  echo "Error: App directory not found: $APP_DIR"
  exit 1
fi

if [ ! -f "$VENV_BIN" ]; then
  echo "Error: Virtualenv not found. Create it first: python -m venv .venv && .venv/bin/pip install -r backend/requirements.txt"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Warning: .env not found at $ENV_FILE. Create it from .env.example and add GATHER_API_BASE_URL, FIRECRAWL_API_KEY."
fi

# Generate service file
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Privacy Audit Flask App
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${VENV_BIN} -w ${WORKERS} -b 127.0.0.1:5120 --timeout 120 backend.app:app
Restart=always
RestartSec=5
Environment="PATH=${APP_DIR}/.venv/bin"
EnvironmentFile=${ENV_FILE}

[Install]
WantedBy=multi-user.target
EOF

echo "Installed ${SERVICE_FILE}"
echo "  App dir:  ${APP_DIR}"
echo "  User:     ${APP_USER}"
echo "  Workers:  ${WORKERS}"
echo "  Env:      ${ENV_FILE}"
echo ""

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

echo ""
echo "Service installed and started. Status:"
systemctl status "$SERVICE_NAME" --no-pager
