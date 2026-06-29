#!/usr/bin/env bash
# deploy-vps.sh — deploy custom-features to Contabo VPS (jebo.ai)
#
# Usage: ./scripts/deploy-vps.sh
#
# The key design: the ENTIRE deploy runs as a single script ON the VPS via
# nohup, so SSH disconnects cannot leave it in a half-done state. The local
# machine just uploads the script, kicks it off, and polls for completion.

set -euo pipefail

VPS="root@109.123.231.227"
KEY="$HOME/.ssh/t1_fetcher_ed25519"
SSH="ssh -i $KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=no"
PORT=12160

# ── Step 1: Upload a self-contained deploy script to the VPS ──
echo "=== Deploying to jebo.ai ==="

$SSH $VPS 'cat > /tmp/omniroute-deploy.sh && chmod +x /tmp/omniroute-deploy.sh' <<'REMOTE_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
LOG=/tmp/omniroute-deploy.log
exec > "$LOG" 2>&1

echo "[$(date)] === DEPLOY START ==="

echo "[$(date)] [1/5] Stopping service..."
systemctl stop omniroute.service || true
sleep 1

echo "[$(date)] [2/5] Pulling latest..."
cd /opt/OmniRoute
git pull origin custom-features

echo "[$(date)] [3/5] Building..."
npm run build
echo "[$(date)] Build exit: $?"

echo "[$(date)] [4/5] Starting service..."
systemctl start omniroute.service

echo "[$(date)] [5/5] Waiting for healthy..."
for i in $(seq 1 30); do
  sleep 2
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:12160/v1/models 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then
    echo "[$(date)] Server UP (HTTP 200) after $((i * 2))s"
    echo "[$(date)] === DEPLOY SUCCESS ==="
    exit 0
  fi
done

echo "[$(date)] === DEPLOY FAILED — server did not come up ==="
journalctl -u omniroute.service --since "60 sec ago" --no-pager 2>/dev/null | tail -15
exit 1
REMOTE_SCRIPT

echo "  Script uploaded."

# ── Step 2: Run it via nohup (survives SSH disconnect) ──
$SSH $VPS 'nohup /tmp/omniroute-deploy.sh &'
echo "  Deploy kicked off on VPS (nohup). Polling for completion..."

# ── Step 3: Poll the log until SUCCESS or FAILED appears ──
while true; do
  sleep 10
  TAIL=$($SSH $VPS 'tail -3 /tmp/omniroute-deploy.log 2>/dev/null' 2>/dev/null || echo "")

  if echo "$TAIL" | grep -q "DEPLOY SUCCESS"; then
    echo ""
    echo "=== DEPLOY COMPLETE ==="
    echo "  https://jebo.ai is live"
    $SSH $VPS 'rm -f /tmp/omniroute-deploy.sh /tmp/omniroute-deploy.log'
    exit 0
  fi

  if echo "$TAIL" | grep -q "DEPLOY FAILED"; then
    echo ""
    echo "=== DEPLOY FAILED ==="
    $SSH $VPS 'cat /tmp/omniroute-deploy.log' 2>/dev/null | tail -20
    exit 1
  fi

  # Show progress
  STEP=$(echo "$TAIL" | grep -oE '\[[0-9]/5\].*' | tail -1 || echo "")
  [ -n "$STEP" ] && echo "  $STEP"
done
