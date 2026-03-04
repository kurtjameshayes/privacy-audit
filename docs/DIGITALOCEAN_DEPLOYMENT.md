# DigitalOcean Droplet Deployment

This guide covers configuring a DigitalOcean droplet to run the privacy-audit app in production.

## 1. Firewall

Allow HTTP/HTTPS and SSH:

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (for nginx)
sudo ufw allow 443/tcp   # HTTPS (for nginx)
sudo ufw enable
```

If you run gunicorn directly without nginx (not recommended for production), also allow 5120:

```bash
sudo ufw allow 5120/tcp
```

## 2. Nginx Reverse Proxy (recommended)

Nginx handles SSL termination and proxies to gunicorn. Install and configure:

```bash
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/privacy-audit`:

```nginx
server {
    listen 80;
    server_name your-domain.com;   # or droplet IP for testing

    location / {
        proxy_pass http://127.0.0.1:5120;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_connect_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/privacy-audit /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

For HTTPS with Let's Encrypt (requires a domain pointing to the droplet):

```bash
sudo certbot --nginx -d your-domain.com
```

## 3. Systemd Service (run app on boot, auto-restart)

Use the install script (recommended):

```bash
sudo ./scripts/install-systemd.sh
```

Or create `/etc/systemd/system/privacy-audit.service` manually:

```ini
[Unit]
Description=Privacy Audit Flask App
After=network.target

[Service]
Type=simple
User=devuser
WorkingDirectory=/home/devuser/app/privacy-audit
ExecStart=/home/devuser/app/privacy-audit/.venv/bin/gunicorn -w 2 -b 127.0.0.1:5120 --timeout 120 --access-logfile /home/devuser/app/privacy-audit/logs/access.log --error-logfile /home/devuser/app/privacy-audit/logs/error.log --capture-output backend.app:app
Restart=always
RestartSec=5
Environment="PATH=/home/devuser/app/privacy-audit/.venv/bin"
EnvironmentFile=/home/devuser/app/privacy-audit/.env

[Install]
WantedBy=multi-user.target
```

**Notes:**
- Binding to `127.0.0.1:5120` (not `0.0.0.0`) is safer when nginx is in front—only localhost can reach gunicorn.
- Create the logs directory before starting: `mkdir -p /home/devuser/app/privacy-audit/logs && chown devuser /home/devuser/app/privacy-audit/logs`
- Logs: `logs/access.log` (HTTP requests), `logs/error.log` (gunicorn and app errors). Use `journalctl -u privacy-audit` for systemd output.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable privacy-audit
sudo systemctl start privacy-audit
sudo systemctl status privacy-audit
```

## 4. Environment Variables

Ensure `.env` exists in the project root with required values:

```bash
cd /home/devuser/app/privacy-audit
cp .env.example .env
# Edit .env with your FIRECRAWL_API_KEY, GATHER_API_BASE_URL, etc.
```

If using systemd, you can add env vars to the service file:

```ini
Environment="PATH=/home/devuser/app/privacy-audit/.venv/bin"
EnvironmentFile=/home/devuser/app/privacy-audit/.env
```

## 5. Logs

| Source | Location |
|--------|----------|
| Access log (HTTP requests) | `logs/access.log` (in app directory) |
| Error log (gunicorn + app) | `logs/error.log` (in app directory) |
| Systemd journal | `journalctl -u privacy-audit -f` |

## 6. Checklist

- [ ] Firewall: ports 80, 443 (and 22 for SSH) open
- [ ] Nginx: installed, configured, proxying to 127.0.0.1:5120
- [ ] SSL: certbot run if using a domain
- [ ] Systemd: service enabled so app starts on boot and restarts on crash
- [ ] `.env`: present and populated with API keys
- [ ] Frontend built: `frontend/dist/` exists (from `npm run build:headless`)
