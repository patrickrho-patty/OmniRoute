---
title: "Fork VPS Deployment Guide"
audience: "Operators deploying patrickrho-patty/OmniRoute to jebo.ai"
lastDeployedCommit: "3b5810bd4"
lastDeployed: "2026-06-30"
---

# Fork VPS Deployment Guide

> This is the **verified runbook** for deploying the `patrickrho-patty/OmniRoute` fork
> (branch `custom-features`) to the production VPS at `jebo.ai`.
>
> Last verified against deploy `3b5810bd4` (bundle tinybert ONNX model) on 2026-06-30.
> Do not paraphrase the paths/flags — they are load-bearing.

## TL;DR

```bash
# On your Mac — one command does the whole deploy:
./scripts/deploy-vps.sh

# The script uploads a self-contained deploy to /tmp on the VPS, kicks it
# off via nohup (so SSH disconnects cannot leave it half-done), then polls
# the VPS log for SUCCESS / FAILED. VPS-side build is ~8–12 min; total ~10–15 min.
```

Then verify (see [Verify the deploy](#verify-the-deploy)).

---

## Architecture & key facts

```text
Client → https://jebo.ai/v1 → Cloudflare edge TLS (Flexible) → Origin Rule (port 12160) → OmniRoute
```

| Item           | Value                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host           | Contabo `109.123.231.227` (24 GB RAM, 8 CPU, 774 GB disk)                                                                                                            |
| Domain         | `https://jebo.ai` (Cloudflare A record → VPS IP, Origin Rule → 12160)                                                                                                |
| Listen port    | **12160** (unprivileged, no setcap needed)                                                                                                                           |
| Service        | `omniroute.service` (systemd, runs as `root`)                                                                                                                        |
| Repo path      | `/opt/OmniRoute` (cloned from GitHub, **built on VPS**)                                                                                                              |
| Data dir       | `/root/.omniroute/` (SQLite + WAL, cache, LLMLingua models)                                                                                                          |
| SSH key        | `~/.ssh/t1_fetcher_ed25519`                                                                                                                                          |
| SSH user       | `root`                                                                                                                                                               |
| Build command  | `npm ci && npm run build` (on VPS — 24 GB RAM is plenty)                                                                                                             |
| Deploy script  | `./scripts/deploy-vps.sh` (local) — pushes + runs on VPS                                                                                                             |
| Poller timeout | 25 min — VPS builds now exceed 10 min (598 static pages + the compression/branding layers); bump in `scripts/deploy-vps.sh` `MAX_POLLS=150` if releases grow further |

### How the deploy script works (`scripts/deploy-vps.sh`)

The entire deploy runs **on the VPS** as a single self-contained script uploaded to
`/tmp/omniroute-deploy.sh`, kicked off via nohup. Steps:

1. **`git fetch origin custom-features` + `git reset --hard`** — dirty trees on the VPS
   can't abort the update.
2. **`npm ci`** — installs any new deps before stopping the service, so no downtime yet.
   The bundled TinyBERT ONNX is a normal git blob (54 MB, under GitHub's 100 MB limit),
   so no Git LFS hydration step is required.
3. **Stop service** (the only downtime window — ~10 min while the build runs).
4. **`npm run build`** (≈8–12 min on Contabo's 8 vCPUs — static-page generation
   dominates; ~600 pages including the recent branding pages and Compression Studio
   dashboard).
5. **Hardened copy** of `.build/next/standalone/` into the install root (chown on the
   new tree before swap).
6. **`systemctl restart omniroute.service`** + health-check loop with auto-recovery
   on boot failure.

The local script polls the VPS log for `=== DEPLOY SUCCESS ===` / `=== DEPLOY FAILED ===`
markers — never assumes success from a clean exit. `harden-against-failures` is wired
inside the remote script: any fail writes the FAILED marker AND tries to restart the
prior service so the site recovers instead of staying down.

> **Why build on the VPS instead of rsyncing the bundle from the Mac?** After the 2026-06-29
> VPS migration from Oracle 1 GB to Contabo 24 GB, RAM is no longer a build risk. Building
> on the VPS removes a class of subtle issues (chunk-hash drift between build host and
> deploy target, missing deps, uid mismatch across hosts) that caused repeated headaches
> with the old rsync flow. The deploy script encapsulates it so the workflow is still one
> command.

### Systemd drop-in overrides

The main unit (`omniroute.service`) is managed by the package; fork-specific runtime
overrides live in `/etc/systemd/system/omniroute.service.d/*.conf` so they survive
package reinstalls. Current drop-ins:

| File                      | What it does                                                       |
| ------------------------- | ------------------------------------------------------------------ |
| `10-disable-live-ws.conf` | `OMNIROUTE_ENABLE_LIVE_WS=0` — disables the live-WS sidecar bridge |

### What is NOT touched by a deploy

- `/root/.omniroute/storage.sqlite` (provider connections, API keys, settings) — **preserved**
- `/root/.omniroute/.env` (data-dir config + `STORAGE_ENCRYPTION_KEY`)
- `/opt/OmniRoute/.env` (build-time / runtime secrets at the install root)
- `/etc/systemd/system/omniroute.service` and its `*.service.d/*.conf` drop-ins — unchanged

A normal code deploy does **not** migrate or reset any production data.

### What IS touched by a deploy

- `/opt/OmniRoute/.build/next/standalone/` — regenerated
- `/opt/OmniRoute/node_modules/` — refreshed by `npm ci` if `package.json` changed
- `/opt/OmniRoute/.next/standalone/` — the live install root (same files as `.build/`)
- `/opt/OmniRoute/models/llmlingua/` — bundled model directory (54 MB tinybert + tokenizer,
  direct git blob; no Git LFS).

### LLMLingua model is bundled in the repo (no HF download needed)

As of `3b5810bd4` the TinyBERT ONNX model (57 MB, public, no HF auth) ships in
`models/llmlingua/atjsh/llmlingua-2-js-tinybert-meetingbank/` as a direct git blob
(under GitHub's 100 MB hard file limit). At runtime, `findBundledModelRoot()` walks
`cwd` + `argv[1]` to locate it, validates that `model.onnx` is a real model blob (not
a Git LFS pointer), and configures the transformers.js env with
`localModelPath = <bundled-root>` and `allowRemoteModels = false`. No HuggingFace
download on the VPS.

If the bundled files are ever missing, the fallback is the data-dir cache
(`/root/.omniroute/models/llmlingua/`) with `allowRemoteModels = true`, so the model
downloads automatically on first use. The `DEFAULT_LLMLINGUA_MODEL = tinybert`
means the small (57 MB) model loads by default; switch to `bert-base` or
`bert-base-ms` in the engine config for higher quality at the cost of a 710 MB
download.

### Never `npm install` inside `.build/`, `.next/`, or `dist/`

These are **assembled standalone bundles** — webpack chunk IDs in compiled page files
reference specific chunk files by number. Running `npm install` inside them mutates
`node_modules` and can corrupt the inline chunk references, causing `Cannot find
module './chunks/NNNNN.js'` errors on SSR pages. If you need an extra dep, add it to
`package.json` at the **repo root before deploy** — `npm ci` will install it correctly
during the deploy script's install step.

### VPS migration gotchas

When moving to a new VPS (cloning the repo + importing the DB from the old machine):

1. **Copy `STORAGE_ENCRYPTION_KEY`** from the old VPS's `.env` to the new one.
   Provider credentials are AES-256-GCM encrypted at rest — without the matching
   key, all connections appear invalid. The key lives in `~/.omniroute/.env` or the
   repo's `.env`.

2. **OAuth tokens expire on migration.** OAuth connections (Claude, Codex,
   ChatGPT-web) are session-bound to the originating machine. After importing the
   DB, these connections show "authentication expired." Re-authenticate them in the
   dashboard. API-key providers (Mistral, OpenAI direct) survive migration.

3. **LLMLingua model pre-cache (first request smoke test).** Even though the model
   ships in the repo, run one compression request after deploy so the first
   `load + warm inference` (~100 ms total) caches the ONNX tensors in process memory:

   ```bash
   curl -sS https://jebo.ai/v1/messages \
     -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
     -H 'Content-Type: application/json' \
     -H 'anthropic-version: 2023-06-01' \
     -d '{"model":"cc/claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}' \
     -o /dev/null -w '%{http_code}\n'   # expect 200
   ```

   Check the compressed / cache_hit log line — `cache_hit=NN%` should appear once
   Anthropic has established the prompt-cache breakpoint on subsequent requests.

---

## Prerequisites

1. **You are on `custom-features`** with the commit you want to deploy pushed to origin:
   ```bash
   git branch --show-current          # must print: custom-features
   git log -1 --format='%H %s'        # confirm the commit
   git status -sb                     # should show "up to date with origin/custom-features"
   ```
2. **Clean working tree** for the files you're deploying (`.pi/` untracked is fine — it stays local).
3. **SSH access works:**
   ```bash
   ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 'hostname; systemctl is-active omniroute.service'
   ```

---

## Step-by-step

### 1. Commit & push the branch

Follow `/cap` (or manually commit + push). The deploy must ship a commit that exists on
`origin/custom-features` so the VPS and GitHub agree:

```bash
git add -A -- . ':!.pi'          # .pi/ stays local
git commit -m "feat(...): ..."
git fetch origin
git push origin custom-features
```

Record the commit SHA — you'll see it echoed by the deploy script.

### 2. Run the deploy script

```bash
./scripts/deploy-vps.sh
```

Expected output (truncated):

```
=== Deploying to jebo.ai ===
=== DEPLOY START ===           # written by the remote script
[1/6] Fetching + hard-resetting to origin/custom-features
[2/6] npm ci
[3/6] Stopping service
[4/6] Building (≈8–12 min)
[5/6] Copying bundle
[6/6] Starting service
=== DEPLOY SUCCESS ===         # terminal marker (poller exits)
```

If the build fails:

```
=== DEPLOY FAILED: <reason> === # terminal marker (poller exits)
```

The script auto-restarts the prior service on failure so the site recovers.

### 3. Verify the deploy

Run these from your Mac after `=== DEPLOY SUCCESS ===`.

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 '
  echo "=== service ==="
  systemctl is-active omniroute.service

  echo "=== deployed commit ==="
  cd /opt/OmniRoute && git rev-parse --short HEAD

  echo "=== bundled tinybert model present? ==="
  ls -lh /opt/OmniRoute/models/llmlingua/atjsh/llmlingua-2-js-tinybert-meetingbank/model.onnx | awk "{print \$5}"

  echo "=== errors in recent logs? ==="
  journalctl -u omniroute.service --since "2 min ago" --no-pager | \
    grep -iE "error|fail|exception|cannot|undefined" || echo "no recent errors found"
'
```

A healthy deploy returns:

- `active` for service status
- the commit SHA you pushed
- ~54 MB for `model.onnx` (real ONNX blob, not a 133-byte LFS pointer)
- `no recent errors found`

**How to verify your change is live:**

```bash
# Replace the marker with a literal from your change
ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 '
  grep -rIo "<marker-from-your-change>" /opt/OmniRoute/.build/next/server/ | wc -l
'
```

Example from `3b5810bd4`:

```bash
# tinybert bundle? (a path that only exists post-deploy)
ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 '
  grep -l "TinyBERT" /opt/OmniRoute/open-sse/services/compression/engines/llmlingua/constants.ts
'
```

### 4. Smoke test through the public endpoint

```bash
curl -sS https://jebo.ai/v1/models \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -o /tmp/models.json -w '%{http_code}\n'    # expect 200

curl -sS https://jebo.ai/v1/messages \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"cc/claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"2+2?"}]}' \
  -o /tmp/messages.json -w '%{http_code}\n'   # expect 200 + real text
```

If both return 200, the deploy is done.

---

## Rollback

The deploy script writes a backup of the previous `dist` tree (the install root) to
`/opt/OmniRoute/dist.bak.<OLD_COMMIT>-pre` before installing the new one. To roll
back without rebuilding:

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 '
  systemctl stop omniroute.service
  rm -rf /opt/OmniRoute/.build/next/standalone
  mv /opt/OmniRoute/.build/next/standalone.bak.<OLD_COMMIT>-pre \
     /opt/OmniRoute/.build/next/standalone   # adjust if backup uses different naming
  # OR, for the old rsync-style deploys:
  # mv /opt/OmniRoute/dist.bak.<OLD_COMMIT>-pre /opt/OmniRoute/dist
  systemctl start omniroute.service
  sleep 3
  systemctl is-active omniroute.service
'
```

If the rollback bucket name varies, list what's on the VPS:

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 'ls -1d /opt/OmniRoute/.bak.* /opt/OmniRoute/.build/next/standalone.bak.* /opt/OmniRoute/dist.bak.* 2>/dev/null'
```

To roll back to a **specific commit** (not the previous deploy's bundle):

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 '
  cd /opt/OmniRoute
  git fetch origin custom-features
  git reset --hard origin/custom-features  # only safe if no uncommitted local changes
  git checkout <OLD_COMMIT>                # or pin to a known-good SHA
  systemctl restart omniroute.service      # no rebuild — code change is minimal? usually NO: rebuild required
'
```

For source-only changes that don't need a rebuild (rare; e.g. config-only): the same
`systemctl restart` reloads Node.

---

## Troubleshooting

| Symptom                                            | Likely cause                                                        | Fix                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build phase hangs on "Collecting page data"        | next-static-pages step; can exceed the 25 min poller                | raise `MAX_POLLS` in `scripts/deploy-vps.sh` (each poll = 10 s); 150 was correct through v3.8.41                                                                                                                                                                                                           |
| Deploy script reports TIMED OUT but service up     | Local poller's 25 min cap hit; VPS script kept running and finished | Confirm with `systemctl is-active omniroute.service`; if active, the deploy actually succeeded                                                                                                                                                                                                             |
| `curl :12160/api/health` → empty / 502             | Service not up or wrong port                                        | `systemctl status omniroute.service`; confirm `PORT=12160` in `/opt/OmniRoute/.env`                                                                                                                                                                                                                        |
| Service crashes on start, `EACCES` in logs         | `.build/next/standalone/` owned by wrong uid (lazy native download) | `chown -R root:root /opt/OmniRoute/.build/next/standalone`; the deploy script does this automatically                                                                                                                                                                                                      |
| Externally unreachable on :12160 but works locally | iptables REJECT rule above ACCEPT                                   | TCP 12160 ACCEPT above REJECT (see `FORK_NOTES.md` OPS-001)                                                                                                                                                                                                                                                |
| `https://jebo.ai` 403s / blocks Anthropic SDK      | Cloudflare AI bot detection                                         | disable CF AI bot detection for `jebo.ai` (see `FORK_NOTES.md` OPS-003)                                                                                                                                                                                                                                    |
| tinybert ONNX shows as ~133 bytes                  | A Git LFS pointer was deployed instead of the real ONNX blob        | This should not happen after the direct-blob fix. Immediate hotfix: `curl -L https://huggingface.co/atjsh/llmlingua-2-js-tinybert-meetingbank/resolve/main/onnx/model.onnx -o /opt/OmniRoute/models/llmlingua/atjsh/llmlingua-2-js-tinybert-meetingbank/model.onnx && systemctl restart omniroute.service` |
| First compression request times out                | ONNX tensors cold-cache + first-call model build                    | expected one-time ~100 ms hit; subsequent requests warm-cache in ~6 ms (see `cache_hit%` in `[USAGE]` log lines)                                                                                                                                                                                           |
| cache_hit% drops after a deploy                    | New compression layer is mutating the cached prefix                 | check engines registry: every engine marked `cacheSafe === false` is dropped for caching providers — see `FORK_NOTES.md` SRC-011                                                                                                                                                                           |
| `cache_hit=NN%` missing from logs                  | Running an older version without the visibility patch               | ensure you've deployed `501548d5e` or later (see `FORK_NOTES.md` SRC-011)                                                                                                                                                                                                                                  |
| `Cannot find module './chunks/NNNNN.js'` (500s)    | Corrupted page chunks from `npm install` inside `.build/`           | never `npm install` in `.build/`; clean-build (`rm -rf .build && cd /opt/OmniRoute && git checkout -- .build && git pull && npm ci && npm run build`), redeploy                                                                                                                                            |

---

## When to deploy

- After a new source patch lands on `custom-features` and is pushed to origin.
- After an upstream rebase onto a new release (see `FORK_NOTES.md` → Rebase procedure).
- Do **not** deploy from an uncommitted working tree — the VPS must match a commit on origin.

## What a deploy does NOT do

- Does **not** run DB migrations manually — `migrationRunner.ts` runs them on service start
  (idempotent, in a transaction). Verify with the startup logs if a migration count changed.
- Does **not** change Cloudflare, DNS, iptables, or systemd unit — those are one-time ops
  documented in `FORK_NOTES.md` (OPS-001…004).
- Does **not** rotate secrets — `.env` stays in place.
- Does **not** invalidate Anthropic's prompt cache — the cached prefix is content-addressed
  on Anthropic's side; only the new traffic grows the cached prefix naturally.

---

## Reference: full deploy command chain (copy-paste)

> Replace `<COMMIT>` with the short SHA you are deploying. This is what
> `./scripts/deploy-vps.sh` does under the hood — invoke manually only when you need
> fine-grained control (debugging, or breaking a long deploy into stages).

```bash
# === On your Mac ===
git push origin custom-features                       # already done if you used /cap

# === One-shot deploy via the script ===
./scripts/deploy-vps.sh

# === Or, step by step ===

# 1. Upload the remote deploy script
scp -i ~/.ssh/t1_fetcher_ed25519 -o ConnectTimeout=20 \
  scripts/deploy-vps.sh \
  root@109.123.231.227:/tmp/

# 2. Kick it off via nohup so SSH disconnects can't kill it
ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 \
  'nohup bash /tmp/omniroute-deploy.sh >/tmp/omniroute-deploy.log 2>&1 &'

# 3. Poll for the terminal marker (remote script writes SUCCESS or FAILED)
ssh -i ~/.ssh/t1_fetcher_ed25519 root@109.123.231.227 \
  'tail -f /tmp/omniroute-deploy.log'  # watch for "=== DEPLOY SUCCESS ===" or "=== DEPLOY FAILED ==="
```

> **Don't** `npm ci && npm run build` on the Mac and rsync the bundle over — the
> deploy script encapsulates the right order (`npm ci` after `git pull`, build on
> the VPS, atomic install + chown). Doing it manually is how we end up with
> chunk-hash corruption.
