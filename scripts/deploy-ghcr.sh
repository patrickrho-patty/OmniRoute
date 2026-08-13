#!/usr/bin/env bash
#
# deploy-ghcr.sh — ONE-SHOT deploy: current working state → CI build → VPS pull.
#
# Replaces the old rsync + build-on-VPS flow (scripts/deploy-omniroute.sh) which
# OOM-killed the swap-less Contabo host during `next build` (~14 GiB RSS). The
# build now runs on GitHub Actions (build-patty-image.yml) and pushes
# ghcr.io/<owner>/omniroute:latest; the VPS just pulls it.
#
# Flow:
#   1. (local)  commit any working-tree changes on the deploy branch
#   2. (local)  push to origin/<branch>            → triggers build-patty-image.yml
#   3. (local)  watch the GitHub Actions run to green → fresh :latest on GHCR
#   4. (remote) docker compose pull && up -d --force-recreate   (no build on the box)
#   5. (remote) poll the health endpoint            → expect "healthy"
#
# Config: this script reads ~/.omniroute-deploy.env (see the template below).
# Anything in that file overrides the defaults; real env vars win over both.
#
# Usage:
#   scripts/deploy-ghcr.sh                   # commit (auto msg) + push + build + deploy
#   scripts/deploy-ghcr.sh -m "feat: x"      # custom commit message
#   scripts/deploy-ghcr.sh --no-commit       # deploy current HEAD as-is (no commit)
#   scripts/deploy-ghcr.sh --build-only      # commit + push + watch CI, skip VPS cutover
#   scripts/deploy-ghcr.sh --vps-only        # just pull+recreate the current :latest
#
set -euo pipefail

# ── Config (defaults — override via ~/.omniroute-deploy.env or env) ──────────
DEPLOY_BRANCH="${OMNIROUTE_DEPLOY_BRANCH:-custom-features}"
WORKFLOW="${OMNIROUTE_DEPLOY_WORKFLOW:-build-patty-image.yml}"
GHCR_IMAGE="${OMNIROUTE_DEPLOY_IMAGE:-ghcr.io/patrickrho-patty/omniroute:latest}"
VPS_HOST="${OMNIROUTE_DEPLOY_HOST:-root@109.123.231.227}"
VPS_KEY="${OMNIROUTE_DEPLOY_KEY:-$HOME/.ssh/t1_fetcher_ed25519}"
VPS_COMPOSE_DIR="${OMNIROUTE_DEPLOY_COMPOSE_DIR:-/opt/omniroute}"
VPS_SERVICE="${OMNIROUTE_DEPLOY_SERVICE:-omniroute}"
VPS_CONTAINER="${OMNIROUTE_DEPLOY_CONTAINER:-omniroute-p5}"
# Health endpoint — the box binds the dashboard to its internal LAN IP:
VPS_HEALTH_URL="${OMNIROUTE_DEPLOY_HEALTH_URL:-http://10.200.85.232:20128/api/monitoring/health}"

# Shellcheck: the config file is intentionally not quoted so a missing one is fine.
# shellcheck disable=SC1090
[ -f "$HOME/.omniroute-deploy.env" ] && . "$HOME/.omniroute-deploy.env"

# ── Flags ────────────────────────────────────────────────────────────────────
COMMIT_MESSAGE=""
NO_COMMIT=0
BUILD_ONLY=0
VPS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message) COMMIT_MESSAGE="$2"; shift 2;;
    --no-commit)  NO_COMMIT=1; shift;;
    --build-only) BUILD_ONLY=1; shift;;
    --vps-only)   VPS_ONLY=1; shift;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

preflight() {
  log "Preflight checks"
  command -v gh >/dev/null || die "gh CLI not installed (brew install gh)."
  gh auth status >/dev/null 2>&1 || die "gh not authenticated (gh auth login)."
  [ -f "$VPS_KEY" ] || die "SSH key not found: $VPS_KEY"
  git remote get-url origin >/dev/null 2>&1 || die "no 'origin' git remote."
  ok "tooling present"
}

commit_and_push() {
  log "Step 1/5 — commit working tree on '$DEPLOY_BRANCH'"
  [ "$(git symbolic-ref --short HEAD 2>/dev/null)" = "$DEPLOY_BRANCH" ] \
    || die "not on '$DEPLOY_BRANCH' (on $(git symbolic-ref --short HEAD 2>/dev/null || echo detached)). Check out $DEPLOY_BRANCH first."

  if [ "$NO_COMMIT" -eq 1 ]; then
    ok "--no-commit: leaving the working tree as-is"
  elif [ -n "$(git status --porcelain)" ]; then
    MSG="${COMMIT_MESSAGE:-deploy: snapshot $(git rev-parse --short HEAD) $(date +%Y-%m-%dT%H:%M%z)}"
    git add -A
    git commit -m "$MSG" >/dev/null
    ok "committed: $MSG"
  else
    ok "working tree clean — nothing to commit"
  fi

  log "Step 2/5 — push to origin/$DEPLOY_BRANCH"
  LOCAL="$(git rev-parse HEAD)"
  git push -u origin "$DEPLOY_BRANCH" >/dev/null 2>&1 || die "git push failed."
  ok "pushed $LOCAL"
}

watch_build() {
  log "Step 3/5 — wait for CI build (workflow: $WORKFLOW)"
  # Give GitHub a moment to register the run triggered by the push.
  sleep 6
  RUN_ID="$(gh run list --workflow="$WORKFLOW" --branch="$DEPLOY_BRANCH" --limit 1 --json databaseId,status --jq '.[0].databaseId')"
  [ -n "$RUN_ID" ] || die "no recent run found for $WORKFLOW on $DEPLOY_BRANCH. Trigger one with: gh workflow run $WORKFLOW"
  ok "watching run $RUN_ID — https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions/runs/$RUN_ID"
  # Watch may exceed long builds; poll instead so we never hang silently.
  for i in $(seq 1 80); do
    # GitHub returns lowercase status/conclusion (e.g. completed/success). Normalize
    # via tr so a case change in the API never breaks the match (portable: macOS bash 3.2).
    STATUS="$(gh run view "$RUN_ID" --json status,conclusion --jq '.status + "/" + (.conclusion // "pending")' | tr '[:upper:]' '[:lower:]')"
    case "$STATUS" in
      completed/success) ok "build green"; return 0;;
      completed/*)       die "build finished as: $STATUS (see the Actions URL above)";;
      *)                 printf '  … %s (%d/80)\n' "$STATUS" "$i"; sleep 30;;
    esac
  done
  die "timed out waiting for build (40 min). Check the Actions URL."
}

vps_cutover() {
  log "Step 4/5 — pull + recreate on $VPS_HOST (no build)"
  # Keep this short so a single SSH call fits well under interactive timeouts.
  ssh -i "$VPS_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=20 "$VPS_HOST" "
    set -e
    cd '$VPS_COMPOSE_DIR'
    docker compose pull $VPS_SERVICE
    docker compose up -d --force-recreate $VPS_SERVICE
  " || die "VPS pull/recreate failed (is the box still logged into ghcr.io?)."
  ok "container recreated from $GHCR_IMAGE"
}

health_check() {
  log "Step 5/5 — health check"
  for i in $(seq 1 30); do
    ST="$(ssh -i "$VPS_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10 "$VPS_HOST" \
      "docker inspect $VPS_CONTAINER --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown")"
    printf '  health[%d/30]=%s\n' "$i" "$ST"
    [ "$ST" = "healthy" ] && break
    sleep 6
  done
  [ "$ST" = "healthy" ] || die "container did not reach healthy (last: $ST)."

  log "Deployed ✅"
  ssh -i "$VPS_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10 "$VPS_HOST" "
    echo '  image:   '\$(docker inspect $VPS_CONTAINER --format '{{.Config.Image}}')
    echo '  version: '\$(docker exec $VPS_CONTAINER sh -c 'node -e \"console.log(require(\\\"/app/package.json\\\").version)\"' 2>/dev/null)
  " 2>/dev/null || true
  echo "  health:  $VPS_HEALTH_URL"
}

# ── Run ──────────────────────────────────────────────────────────────────────
preflight

if [ "$VPS_ONLY" -eq 1 ]; then
  vps_cutover; health_check; exit 0
fi

commit_and_push
watch_build
[ "$BUILD_ONLY" -eq 1 ] && { log "—build-only: skipping VPS cutover"; exit 0; }
vps_cutover
health_check
