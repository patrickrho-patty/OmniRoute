#!/usr/bin/env bash
#
# deploy-omniroute.sh — Deploy the fork image to the production VPS (pull-based).
#
# Deployment model (rewritten 2026-09-28 after the "phantom deploy" incident):
#   1. A push to `patty` triggers .github/workflows/build-patty-image.yml, which
#      builds on GitHub runners and publishes
#      ghcr.io/patrickrho-patty/omniroute:{latest,sha-<short7>,<branch>} to GHCR.
#   2. This script refuses to deploy unless the CI run for the target commit
#      concluded successfully, pulls the commit's `sha-<short7>` tag and the
#      registry `:latest` on the box, and verifies both resolve to the SAME
#      image. Only then does it `docker compose up -d omniroute`, wait for the
#      container healthcheck, re-verify the RUNNING image digest, and probe the
#      public edge health endpoint.
#
# Why there is no rsync / local build anymore:
#   The compose service on the box is PULL-ONLY (`image: ghcr.io/...`,
#   `pull_policy: always`, no `build:` section). The old rsync+`docker compose
#   build` flow silently built nothing and recreated the container from
#   whatever image was last published — on 2026-09-28 that shipped a "deploy"
#   that actually restarted yesterday's code (the deepseek 1M-window fix went
#   live ~2h late because of this). Builds also moved off the box on
#   2026-08-05: in-Docker `next build` OOM-killed the swap-less host.
#
# Box reality (audited live 2026-09-28):
#   - Contabo 109.123.231.227 — THE OmniRoute box. `omniroute-p5` runs behind
#     Caddy there; omni.patty.io's AWS edge IPs front exactly this host.
#     App dir: /opt/omniroute (docker-compose.yml, .env, data/).
#   - Hostinger 187.127.115.221 — NO LONGER RUNS OMNIROUTE (now Backstage +
#     Postgres). Removed as a deploy target; do not re-add without re-auditing.
#
# Usage:
#   ./scripts/deploy-omniroute.sh                # deploy HEAD (CI must be green for it)
#   ./scripts/deploy-omniroute.sh --wait         # poll CI until HEAD's build finishes, then deploy
#   ./scripts/deploy-omniroute.sh --sha <ref>    # deploy a specific commit (CI must be green for it)
#   ./scripts/deploy-omniroute.sh --check        # read-only: current box + edge status
#   ./scripts/deploy-omniroute.sh --force        # skip only the CI-green gate (digest
#                                                # verification against the sha tag still applies)
#
# Rollback (manual, on the box):
#   docker tag ghcr.io/patrickrho-patty/omniroute:sha-<old7> ghcr.io/patrickrho-patty/omniroute:latest
#   cd /opt/omniroute && docker compose up -d --pull never omniroute
#
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
KEY="${OMNIROUTE_DEPLOY_KEY:-$HOME/.ssh/t1_fetcher_ed25519}"
SSH_BASE=(-i "$KEY" -o ConnectTimeout=30 -o StrictHostKeyChecking=no -o BatchMode=yes)
BOX_IP="109.123.231.227"
BOX_DIR="/opt/omniroute"
BOX_CONTAINER="omniroute-p5"
BOX_SERVICE="omniroute"
IMAGE="ghcr.io/patrickrho-patty/omniroute"
FORK_REPO="patrickrho-patty/OmniRoute"
WORKFLOW="build-patty-image.yml"
EDGE_HEALTH_URL="https://omni.patty.io/api/monitoring/health"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo -e "\033[1m[$1]\033[0m $2"; }
ok()   { echo -e "  \033[32m✓\033[0m $1"; }
fail() { echo -e "  \033[31m✗\033[0m $1"; }
info() { echo -e "  \033[34m→\033[0m $1"; }
remote() { ssh "${SSH_BASE[@]}" "root@${BOX_IP}" "$1"; }

usage() { grep '^#' "$0" | head -32; exit 0; }

# ── Flags ────────────────────────────────────────────────────────────────────
MODE="deploy"
TARGET_REF="HEAD"
FORCE=false
WAIT=false

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --wait)  WAIT=true ;;
    --force) FORCE=true ;;
    --sha)
      shift
      if [ $# -eq 0 ]; then fail "--sha requires a ref"; exit 1; fi
      TARGET_REF="$1"
      ;;
    -h|--help) usage ;;
    *)
      fail "Unknown flag: $1"
      usage
      ;;
  esac
  shift
done

# ── Read-only status mode ────────────────────────────────────────────────────
if [ "$MODE" = "check" ]; then
  log "check" "=== $BOX_CONTAINER on Contabo ($BOX_IP) ==="
  if ! remote 'echo ok' >/dev/null 2>&1; then
    fail "Cannot SSH to $BOX_IP"
    exit 1
  fi
  remote "docker ps --filter name=${BOX_CONTAINER} --format '{{.Names}} | {{.Status}} | {{.Image}}'
docker inspect ${BOX_CONTAINER} --format 'image id: {{.Image}}' 2>/dev/null
docker image inspect ${IMAGE}:latest --format 'latest built: {{.Created}}' 2>/dev/null"
  local_short="$(git -C "$REPO_ROOT" rev-parse --short=7 HEAD 2>/dev/null || echo '?')"
  remote "docker image inspect ${IMAGE}:sha-${local_short} --format 'HEAD image (${local_short}) present: {{.Id}}' 2>/dev/null || echo 'HEAD image (sha-${local_short}) NOT on box'"
  echo ""
  log "edge" "=== ${EDGE_HEALTH_URL} ==="
  curl -sf -m 15 "$EDGE_HEALTH_URL" && echo || fail "Edge health unreachable"
  exit 0
fi

# ── Resolve the target commit ────────────────────────────────────────────────
FULL_SHA="$(git -C "$REPO_ROOT" rev-parse "${TARGET_REF}^{}" 2>/dev/null)" || {
  fail "Cannot resolve ref '${TARGET_REF}' in ${REPO_ROOT}"
  exit 1
}
SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=7 "${TARGET_REF}^{}")"
if [ "$FULL_SHA" != "$(git -C "$REPO_ROOT" rev-parse HEAD)" ]; then
  info "Deploying non-HEAD commit ${SHORT_SHA}"
fi
# The image can only exist if the commit is pushed to the fork's deploy branch.
if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$FULL_SHA" origin/patty 2>/dev/null; then
  fail "${SHORT_SHA} is not on origin/patty — push first (the image is built from the branch push)"
  exit 1
fi
ok "Target commit: ${SHORT_SHA} (${FULL_SHA})"

# ── CI gate ──────────────────────────────────────────────────────────────────
ci_state() {
  gh run list -R "$FORK_REPO" --workflow "$WORKFLOW" --limit 20 \
    --json headSha,status,conclusion \
    --jq ".[] | select(.headSha == \"${FULL_SHA}\") | .status + \"/\" + (.conclusion // \"pending\")" \
    | head -1
}

if [ "$FORCE" = false ]; then
  if ! command -v gh >/dev/null 2>&1; then
    fail "gh CLI not found — cannot verify the CI build. Install gh or pass --force (digest check still applies)."
    exit 1
  fi
  WAIT_POLLS=0
  while :; do
    STATE="$(ci_state || true)"
    case "$STATE" in
      completed/success)
        ok "CI build green for ${SHORT_SHA}"
        break
        ;;
      "")
        if [ "$WAIT" = true ]; then
          WAIT_POLLS=$((WAIT_POLLS + 1))
          if [ "$WAIT_POLLS" -ge 60 ]; then
            fail "No CI run for ${SHORT_SHA} after ~20 minutes of polling — giving up."
            exit 1
          fi
          info "No CI run for ${SHORT_SHA} yet — waiting..."
          sleep 20
        else
          fail "No CI run found for ${SHORT_SHA}. Use --wait to poll, or --force."
          exit 1
        fi
        ;;
      *in_progress*|*queued*|*pending*)
        if [ "$WAIT" = true ]; then
          WAIT_POLLS=$((WAIT_POLLS + 1))
          if [ "$WAIT_POLLS" -ge 60 ]; then
            fail "CI build for ${SHORT_SHA} still ${STATE} after ~20 minutes of polling — giving up."
            exit 1
          fi
          info "CI ${STATE} — waiting..."
          sleep 20
        else
          fail "CI build for ${SHORT_SHA} is ${STATE}. Use --wait to poll until it finishes."
          exit 1
        fi
        ;;
      *)
        fail "CI build for ${SHORT_SHA} is ${STATE} — refusing to deploy a broken build."
        exit 1
        ;;
    esac
  done
else
  fail "--force: skipping the CI-green gate (digest verification still applies)"
fi

# ── Deploy on the box ────────────────────────────────────────────────────────
log "box" "=== Deploying ${SHORT_SHA} to Contabo (${BOX_IP}) ==="

info "Testing SSH connectivity..."
if ! remote 'echo ok' >/dev/null 2>&1; then
  fail "Cannot SSH to ${BOX_IP}"
  exit 1
fi
ok "SSH connected"

info "Sanity: compose service present..."
if ! remote "cd ${BOX_DIR} && docker compose config --services 2>/dev/null | grep -qx '${BOX_SERVICE}'"; then
  fail "Service '${BOX_SERVICE}' not found in ${BOX_DIR}/docker-compose.yml — box layout changed, re-audit this script."
  exit 1
fi
ok "Compose service '${BOX_SERVICE}' present"

info "Pulling the commit image ${IMAGE}:sha-${SHORT_SHA}..."
if ! remote "docker pull ${IMAGE}:sha-${SHORT_SHA}" >/dev/null 2>&1; then
  fail "ghcr.io has no image tag sha-${SHORT_SHA}. Did the CI workflow run and publish? (push to patty triggers it)"
  exit 1
fi
ok "Commit image pulled"

info "Pulling registry :latest and verifying it IS the commit build..."
remote "cd ${BOX_DIR} && docker compose pull ${BOX_SERVICE}" >/dev/null
SHA_ID="$(remote "docker image inspect --format '{{.Id}}' ${IMAGE}:sha-${SHORT_SHA}")"
LATEST_ID="$(remote "docker image inspect --format '{{.Id}}' ${IMAGE}:latest")"
if [ -z "$SHA_ID" ] || [ "$SHA_ID" != "$LATEST_ID" ]; then
  fail "Registry :latest (${LATEST_ID:-none}) is NOT build sha-${SHORT_SHA} (${SHA_ID})."
  fail "Refusing to recreate the container from unverified code. Wait for CI to publish, or investigate."
  exit 1
fi
ok ":latest == sha-${SHORT_SHA} (${SHA_ID:0:19}…) — verified"

OLD_IMAGE_ID="$(remote "docker inspect ${BOX_CONTAINER} --format '{{.Image}}' 2>/dev/null || echo none")"
info "Previous running image: ${OLD_IMAGE_ID}"

info "Recreating container..."
remote "cd ${BOX_DIR} && docker compose up -d ${BOX_SERVICE}" >/dev/null
ok "Container recreated"

info "Waiting for healthcheck..."
healthy=false
for _ in $(seq 1 30); do
  status="$(remote "docker inspect ${BOX_CONTAINER} --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown")"
  if [ "$status" = "healthy" ]; then healthy=true; break; fi
  sleep 5
done
if [ "$healthy" != true ]; then
  fail "Container not healthy after 150s — check: ssh ${BOX_IP} 'docker logs --tail 100 ${BOX_CONTAINER}'"
  exit 1
fi
ok "Container healthy"

info "Post-verify: running image is the verified build..."
RUNNING_ID="$(remote "docker inspect ${BOX_CONTAINER} --format '{{.Image}}'")"
if [ "$RUNNING_ID" != "$SHA_ID" ]; then
  fail "Running image (${RUNNING_ID}) != verified build (${SHA_ID}). Investigate before trusting this deploy."
  exit 1
fi
ok "Running image matches sha-${SHORT_SHA}"

BUILT_AT="$(remote "docker image inspect --format '{{.Created}}' ${IMAGE}:latest")"
info "Image built at: ${BUILT_AT}"

# ── Edge verification ────────────────────────────────────────────────────────
log "edge" "=== ${EDGE_HEALTH_URL} ==="
edge_ok=false
for _ in $(seq 1 4); do
  if curl -sf -m 15 "$EDGE_HEALTH_URL" >/dev/null 2>&1; then edge_ok=true; break; fi
  sleep 5
done
if [ "$edge_ok" != true ]; then
  fail "Edge health did not answer after container became healthy — check Caddy/edge routing."
  exit 1
fi
ok "Edge healthy"

log "main" "✅ ${SHORT_SHA} deployed and verified (previous image: ${OLD_IMAGE_ID})"
