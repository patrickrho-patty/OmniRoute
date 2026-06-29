#!/usr/bin/env bash
# deploy-vps.sh — deploy custom-features to the Contabo VPS (jebo.ai)
#
# Usage:
#   ./scripts/deploy-vps.sh
#
# What it does (in order):
#   1. SSH to VPS
#   2. Stop the service
#   3. git pull
#   4. npm run build (full CPU, no service competing)
#   5. Start the service
#   6. Wait for healthy
#   7. Report result
#
# Prerequisites:
#   - SSH key: ~/.ssh/t1_fetcher_ed25519
#   - Commits pushed to origin/custom-features

set -euo pipefail

VPS_HOST="109.123.231.227"
VPS_USER="root"
SSH_KEY="$HOME/.ssh/t1_fetcher_ed25519"
SSH="ssh -i $SSH_KEY -o ConnectTimeout=20 -o ServerAliveInterval=30 $VPS_USER@$VPS_HOST"
PORT=12160

echo "=== Deploy to $VPS_HOST ==="

echo "[1/5] Stopping service..."
$SSH 'systemctl stop omniroute.service' 2>/dev/null
echo "      Stopped."

echo "[2/5] Pulling latest..."
$SSH 'cd /opt/OmniRoute && git pull origin custom-features 2>&1 | tail -3'

echo "[3/5] Building (this takes ~8 min)..."
$SSH "cd /opt/OmniRoute && npm run build 2>&1 | tail -5"
echo "      Build done."

echo "[4/5] Starting service..."
$SSH 'systemctl start omniroute.service'

echo "[5/5] Waiting for healthy..."
for i in $(seq 1 30); do
  sleep 2
  STATUS=$($SSH "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/v1/models 2>/dev/null" || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "      Server UP (HTTP 200) after $((i * 2))s"
    echo ""
    echo "=== Deploy complete ==="
    echo "  https://jebo.ai is live"
    exit 0
  fi
  echo "      attempt $i: HTTP $STATUS"
done

echo "ERROR: Server did not come up within 60s"
$SSH 'journalctl -u omniroute.service --since "60 sec ago" --no-pager 2>/dev/null | tail -10'
exit 1
