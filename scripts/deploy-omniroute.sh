#!/usr/bin/env bash
#
# deploy-omniroute.sh — Deploy OmniRoute to Contabo and/or Hostinger via Docker.
#
# Usage:
#   ./scripts/deploy-omniroute.sh --hostinger          # deploy to Hostinger (prod)
#   ./scripts/deploy-omniroute.sh --contabo            # deploy to Contabo (staging)
#   ./scripts/deploy-omniroute.sh --both               # deploy to both (parallel)
#   ./scripts/deploy-omniroute.sh --hostinger --check  # just verify, don't rebuild
#   ./scripts/deploy-omniroute.sh --contabo --no-cache # clean rebuild (no Docker cache)
#
# What it does per target:
#   1. rsync the local source tree → /opt/omniroute/app/ (excludes node_modules, .build, etc.)
#   2. Build the Docker image (patty/omniroute:p5) on the target
#   3. Recreate the omniroute container (--force-recreate)
#   4. Wait for healthcheck (healthy)
#   5. Verify: version + health endpoint
#
# What it does NOT touch:
#   - .env (each box has its own env — never overwritten)
#   - data/ (each box has its own SQLite DB — never overwritten)
#   - TLS certs / nginx config (managed separately)
#
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
KEY="${OMNIROUTE_DEPLOY_KEY:-$HOME/.ssh/t1_fetcher_ed25519}"
SSH_BASE=(-i "$KEY" -o ConnectTimeout=30 -o StrictHostKeyChecking=no -o BatchMode=yes)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Target boxes (public IPs — reachable from anywhere; VPN IPs are for the services)
HOSTINGER_IP="187.127.115.221"
HOSTINGER_NAME="Hostinger (prod)"
CONTABO_IP="109.123.231.227"
CONTABO_NAME="Contabo (staging)"

# rsync excludes — NOTE: /logs/ is ROOT-anchored so it doesn't strip
# src/app/(dashboard)/dashboard/logs/ (the logs page)! A bare `logs/` pattern
# matches at any depth and silently drops the page → 404.
EXCLUDES=(
  --exclude='node_modules/'
  --exclude='.build/'
  --exclude='dist/'
  --exclude='.git/'
  --exclude='.next/'
  --exclude='.opencode/'
  --exclude='.env' --exclude='.env.*'
  --exclude='/logs/'
  --exclude='/coverage/'
  --exclude='.turbo/'
  --exclude='.DS_Store'
  --exclude='*.sqlite' --exclude='*.sqlite-*' --exclude='*.db'
  --exclude='playwright-report/' --exclude='test-results/'
)

# ── Flags ────────────────────────────────────────────────────────────────────
DEPLOY_HOSTINGER=false
DEPLOY_CONTABO=false
NO_CACHE=""
CHECK_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --hostinger) DEPLOY_HOSTINGER=true ;;
    --contabo)   DEPLOY_CONTABO=true ;;
    --both)      DEPLOY_HOSTINGER=true; DEPLOY_CONTABO=true ;;
    --no-cache)  NO_CACHE="--no-cache" ;;
    --check)     CHECK_ONLY=true ;;
    -h|--help)
      grep '^#' "$0" | head -20
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

if ! $DEPLOY_HOSTINGER && ! $DEPLOY_CONTABO; then
  echo "Error: specify --hostinger, --contabo, or --both"
  exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo -e "\033[1m[$1]\033[0m $2"; }
ok()   { echo -e "  \033[32m✓\033[0m $1"; }
fail() { echo -e "  \033[31m✗\033[0m $1"; }
info() { echo -e "  \033[34m→\033[0m $1"; }

# ── Deploy to a single box ──────────────────────────────────────────────────
deploy_to_box() {
  local box="$1"
  local ip name
  case "$box" in
    hostinger) ip="$HOSTINGER_IP"; name="$HOSTINGER_NAME" ;;
    contabo)   ip="$CONTABO_IP";  name="$CONTABO_NAME"  ;;
    *) echo "Unknown box: $box"; return 1 ;;
  esac
  local ssh_cmd=(ssh "${SSH_BASE[@]}" "root@$ip")

  log "$box" "=== Deploying to $name ($ip) ==="

  # 1. Check connectivity
  info "Testing SSH connectivity..."
  if ! "${ssh_cmd[@]}" 'echo ok' >/dev/null 2>&1; then
    fail "Cannot SSH to $box ($ip)"
    return 1
  fi
  ok "SSH connected"

  # 2. Check-only mode: just verify
  if $CHECK_ONLY; then
    info "Check-only mode — verifying current deployment..."
    local health version
    health=$("${ssh_cmd[@]}" 'docker inspect omniroute-p5 --format "{{.State.Health.Status}}" 2>/dev/null || echo unknown')
    version=$("${ssh_cmd[@]}" 'docker exec omniroute-p5 node -e "console.log(require(\"/app/package.json\").version)" 2>/dev/null || echo unknown')
    ok "Container: omniroute-p5 | Health: $health | Version: $version"
    return 0
  fi

  # 3. rsync source
  info "rsync source → /opt/omniroute/app/ ..."
  rsync -az --delete --info=stats1 \
    -e "ssh ${SSH_BASE[*]}" \
    "${EXCLUDES[@]}" \
    "$REPO_ROOT/" "root@$ip:/opt/omniroute/app/" 2>&1 | tail -1
  ok "Source synced"

  # 4. Build Docker image (foreground — waits for completion)
  info "Building Docker image ${NO_CACHE:+(no-cache)}..."
  local build_exit
  "${ssh_cmd[@]}" "cd /opt/omniroute && docker compose build $NO_CACHE omniroute" 2>&1 | {
    grep -E "Compiled successfully|ERROR|failed to solve|✓" || true
  }
  build_exit=${PIPESTATUS[0]}
  if [ "$build_exit" -ne 0 ]; then
    fail "Build failed (exit $build_exit)"
    return 1
  fi
  ok "Image built"

  # 5. Recreate container
  info "Recreating container..."
  "${ssh_cmd[@]}" 'cd /opt/omniroute && docker compose up -d --force-recreate --no-build omniroute' 2>&1 | tail -2

  # 6. Wait for healthcheck
  info "Waiting for healthcheck..."
  local healthy=false
  for i in $(seq 1 20); do
    local status
    status=$("${ssh_cmd[@]}" 'docker inspect omniroute-p5 --format "{{.State.Health.Status}}" 2>/dev/null || echo unknown')
    if [ "$status" = "healthy" ]; then
      healthy=true
      break
    fi
    sleep 5
  done

  if $healthy; then
    ok "Container healthy"
  else
    fail "Container not healthy after 100s"
    return 1
  fi

  # 7. Verify
  local version
  version=$("${ssh_cmd[@]}" 'docker exec omniroute-p5 node -e "console.log(require(\"/app/package.json\").version)" 2>/dev/null || echo unknown')
  ok "Deployment verified — Version: $version"

  log "$box" "=== Done ==="
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────
EXIT_CODE=0

if $DEPLOY_HOSTINGER && $DEPLOY_CONTABO; then
  log "main" "Deploying to BOTH boxes in parallel..."
  deploy_to_box hostinger &
  PID_H=$!
  deploy_to_box contabo &
  PID_C=$!
  wait $PID_H || EXIT_CODE=1
  wait $PID_C || EXIT_CODE=1
elif $DEPLOY_HOSTINGER; then
  deploy_to_box hostinger || EXIT_CODE=1
elif $DEPLOY_CONTABO; then
  deploy_to_box contabo || EXIT_CODE=1
fi

if [ "$EXIT_CODE" -eq 0 ]; then
  log "main" "✅ All deployments succeeded"
else
  log "main" "⚠️  Some deployments failed — check output above"
fi
exit $EXIT_CODE
