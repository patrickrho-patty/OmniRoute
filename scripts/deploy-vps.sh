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
# NOTE: deliberately NOT using `set -e`. Every fallible step is guarded with
# `|| fail "..."` so that ANY failure (a) writes the `DEPLOY FAILED` marker the
# local poller watches for, and (b) brings the existing service back up, instead
# of dying mid-script under `set -e` and leaving the site down with no marker.
set -uo pipefail
LOG=/tmp/omniroute-deploy.log
exec > "$LOG" 2>&1

# On ANY failure: mark FAILED (so the poller stops waiting) and restart the
# already-built service so the site recovers rather than staying down.
fail() {
  echo "[$(date)] === DEPLOY FAILED: $1 ==="
  echo "[$(date)] Attempting to restore service (keep site up)..."
  systemctl start omniroute.service || true
  journalctl -u omniroute.service --since "90 sec ago" --no-pager 2>/dev/null | tail -15
  exit 1
}

echo "[$(date)] === DEPLOY START ==="
cd /opt/OmniRoute || fail "cd /opt/OmniRoute"

# Hard-reset to the remote so a dirty working tree (e.g. a locally-modified
# package-lock.json from a prior npm run) can never abort the update.
echo "[$(date)] [1/6] Fetching + hard-resetting to origin/custom-features..."
git fetch origin custom-features || fail "git fetch"
git reset --hard origin/custom-features || fail "git reset --hard"
echo "[$(date)] Now at $(git rev-parse --short HEAD)"

# Install deps BEFORE stopping the service (no downtime) so newly-added
# dependencies are present before the build resolves them. This is the step
# whose absence caused webpack 'Module not found' build failures.
echo "[$(date)] [2/6] Installing dependencies (npm install)..."
npm install --no-audit --no-fund || fail "npm install"

echo "[$(date)] [3/6] Stopping service..."
systemctl stop omniroute.service || true
sleep 1

echo "[$(date)] [4/6] Building..."
npm run build || fail "npm run build"

echo "[$(date)] [5/6] Starting service..."
systemctl start omniroute.service || fail "systemctl start"

echo "[$(date)] [6/6] Waiting for healthy..."
for i in $(seq 1 30); do
  sleep 2
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:12160/v1/models 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then
    echo "[$(date)] Server UP (HTTP 200) after $((i * 2))s"
    echo "[$(date)] === DEPLOY SUCCESS ==="
    exit 0
  fi
done

fail "server did not come up within 60s"
REMOTE_SCRIPT

echo "  Script uploaded."

# ── Step 2: Run it via nohup (survives SSH disconnect) ──
$SSH $VPS 'nohup /tmp/omniroute-deploy.sh &'
echo "  Deploy kicked off on VPS (nohup). Polling for completion..."

# ── Step 3: Poll the log until SUCCESS or FAILED appears ──
# Hard timeout so a wedged build can never make the poller hang forever (it did
# once, leaving the service stopped with no signal). 150 polls * 10s = 25 min —
# the full Next build (~600 static pages + standalone assembly) can exceed 10 min,
# so keep this generously above it to avoid a misleading "timed out" on a healthy deploy.
MAX_POLLS=150
poll=0
while true; do
  sleep 10
  poll=$((poll + 1))
  TAIL=$($SSH $VPS 'tail -4 /tmp/omniroute-deploy.log 2>/dev/null' 2>/dev/null || echo "")

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
    $SSH $VPS 'cat /tmp/omniroute-deploy.log' 2>/dev/null | tail -25
    exit 1
  fi

  if [ "$poll" -ge "$MAX_POLLS" ]; then
    echo ""
    echo "=== DEPLOY TIMED OUT after $((MAX_POLLS * 10))s — no SUCCESS/FAILED marker ==="
    echo "  Service status: $($SSH $VPS 'systemctl is-active omniroute.service' 2>/dev/null)"
    $SSH $VPS 'tail -25 /tmp/omniroute-deploy.log' 2>/dev/null
    exit 2
  fi

  # Show progress
  STEP=$(echo "$TAIL" | grep -oE '\[[0-9]/[0-9]\].*' | tail -1 || echo "")
  [ -n "$STEP" ] && echo "  [$poll/$MAX_POLLS] $STEP"
done
