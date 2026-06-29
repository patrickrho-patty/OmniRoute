---
title: "Fork VPS Deployment Guide"
audience: "Operators deploying patrickrho-patty/OmniRoute to jebo.ai"
lastDeployedCommit: "680b8c00c"
lastDeployed: "2026-06-28"
---

# Fork VPS Deployment Guide

> This is the **verified runbook** for deploying the `patrickrho-patty/OmniRoute` fork
> (branch `custom-features`) to the production VPS at `jebo.ai`.
>
> Every command below was executed during the `680b8c00c` deploy. Do not paraphrase the
> paths/flags — they are load-bearing (especially `--delete --exclude logs/` and the
> `.build/next` distDir).

## TL;DR

```bash
# On your Mac (build host):
npm run build                                   # → .build/next/standalone/
rsync -az --delete --exclude '/logs/' \
  -e "ssh -i ~/.ssh/t1_fetcher_ed25519" \
  .build/next/standalone/ \
  ubuntu@161.33.162.164:/usr/lib/node_modules/omniroute/dist/

# On the VPS (one ssh hop):
ssh ubuntu@161.33.162.164 'sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute/dist \
  && sudo systemctl restart omniroute.service'
```

Then verify (see [Step 6](#6-verify-the-deploy)).

---

## Architecture & key facts

```text
Client → https://jebo.ai/v1 → Cloudflare edge TLS (Flexible) → Origin Rule (port 12160) → OmniRoute
```

| Item          | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| Host          | Contabo `109.123.231.227` (24 GB RAM, 8 CPU, 774 GB disk)             |
| Domain        | `https://jebo.ai` (Cloudflare A record → VPS IP, Origin Rule → 12160) |
| Listen port   | **12160** (unprivileged, no setcap needed)                            |
| Service       | `omniroute.service` (systemd, `npm start`, runs as `root`)            |
| Repo path     | `/opt/OmniRoute` (cloned from GitHub, built on VPS)                   |
| Data dir      | `/root/.omniroute/` (SQLite + WAL)                                    |
| SSH key       | `~/.ssh/t1_fetcher_ed25519`                                           |
| SSH user      | `root`                                                                |
| Build command | `npm run build` (on VPS — 24 GB RAM, no rsync needed)                 |
| Deploy flow   | `git pull → npm run build → systemctl restart omniroute.service`      |

### Systemd drop-in overrides

The main unit (`omniroute.service`) is managed by the package; fork-specific runtime
overrides live in `/etc/systemd/system/omniroute.service.d/*.conf` so they survive
package reinstalls. Current drop-ins:

| File                      | What it does                                                             |
| ------------------------- | ------------------------------------------------------------------------ |
| `10-disable-live-ws.conf` | `OMNIROUTE_ENABLE_LIVE_WS=0` — disables the live-WS sidecar bridge       |
| `20-heap-limit.conf`      | `NODE_OPTIONS=--max-old-space-size=768` — raises the V8 heap from ~512MB |

The VPS has **954 MB RAM + 2 GB swap**. The default V8 heap limit (~512 MB on a 1 GB
machine) caused OOM crashes after the v3.8.38 rebase (larger bundle: ionizer engine,
new providers, fidelity gate). 768 MB leaves ~180 MB for the OS and swap backs any
transient spikes. If a future upstream release is even larger, bump this value — but
watch `free -h` to make sure OS + Node fit in RAM without constant swap thrashing.

### Why we rsync instead of building on the VPS

The VPS is small (45 GB disk, limited RAM). `next build` is heavy and would risk OOM or
compete with the running service. So we **build on the Mac** and rsync the already-assembled
bundle. The VPS runs the `omniroute` CLI entry point — `ExecStart=/usr/bin/omniroute`, a
symlink to `bin/omniroute.mjs` at the install root — which launches the standalone server
from `dist/`. No build step on the VPS.

Note: `bin/omniroute.mjs` lives at the install root, **not** in `dist/`, so a normal
`dist/` rsync does not touch the CLI entry — only the server bundle it launches.

rsync delta-syncs, so despite a ~775 MB bundle, the actual transfer is tiny (e.g. ~16 MB
when most of `node_modules` is unchanged between deploys).

### What is NOT touched by a deploy

- `/home/ubuntu/.omniroute/storage.sqlite` (provider connections, API keys, settings) — **preserved**
- `/home/ubuntu/.omniroute/.env` and `/usr/lib/node_modules/omniroute/.env` (secrets) — at install root, **not in `dist/`**
- `/etc/systemd/system/omniroute.service` — unchanged
- `dist/logs/` — preserved by `--exclude logs/`

A normal code deploy does **not** migrate or reset any production data.

### Never `npm install` inside `dist/`

The `dist/` directory is an **assembled standalone bundle** — webpack chunk IDs in
compiled page files reference specific chunk files by number. Running `npm install` in
`dist/` mutates `node_modules` and can corrupt the inline chunk references, causing
`Cannot find module './chunks/NNNNN.js'` errors on SSR pages. The corruption is subtle:
rsync with default flags may not detect the byte-level changes (matching file sizes +
close mtimes). If you need an extra dependency (e.g. `@atjsh/llmlingua-2` for
LLMLingua), install it in the **main checkout before `npm run build`** so it's included
in the assembled bundle, or use `scp` to copy the missing package directly into
`dist/node_modules/` without running npm's resolver.

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

3. **LLMLingua ONNX model pre-download.** The BERT model (~680 MB) downloads on
   first use from HuggingFace Hub. Pre-download it after a fresh deploy so the
   first compression request doesn't time out:

   ```bash
   cd /opt/OmniRoute && node --import tsx/esm -e "
     import { configureTransformersEnv } from './open-sse/services/compression/engines/llmlingua/modelStore.ts';
     const { env } = await import('@huggingface/transformers');
     configureTransformersEnv(env, {});
     const { LLMLingua2 } = await import('@atjsh/llmlingua-2');
     const { Tiktoken } = await import('js-tiktoken/lite');
     const o200k_base = (await import('js-tiktoken/ranks/o200k_base')).default;
     const { promptCompressor } = await LLMLingua2.WithBERTMultilingual(
       'Arcoldd/llmlingua4j-bert-base-onnx',
       { transformerJSConfig: { device: 'cpu', dtype: 'fp32' },
         oaiTokenizer: new Tiktoken(o200k_base),
         modelSpecificOptions: { subfolder: '' }, logger: () => {} });
     console.log('Model cached');
   "
   ```

4. **rsync `--exclude` anchoring.** Use `--exclude '/logs/'` (leading `/`), not
   `--exclude 'logs/'`. Without the anchor, rsync excludes every path segment
   named `logs/` — including `app/api/logs/` and `dashboard/logs/` routes.

5. **Systemd entry point.** When running from a cloned repo (not an npm-installed
   package), use `npm start` as the ExecStart (runs `next start` with full
   initialization). The standalone `server.js` works for the API but the CLI
   entry point (`bin/omniroute.mjs serve`) expects a `dist/` directory — symlink
   `.build/next/standalone` to `dist` if using the CLI.

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
   ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164 'hostname; systemctl is-active omniroute.service'
   ```
4. **Build deps on the Mac:** Node `>=22`, deps installed (`npm ci` or `npm install`).

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

Record the commit SHA — you'll use it for the rollback backup name.

### 2. Build locally

```bash
npm run build
```

Watch for a clean exit (exit code 0) and the final `[assembleStandalone] Synced module:`
lines in the output — that means the assembled bundle is ready. The build produces the
assembled bundle at:

```bash
ls -la .build/next/standalone/server.js          # must exist
ls    .build/next/standalone/migrations/ | head  # migrations present
du -sh .build/next/standalone/                   # ~700–800 MB
```

> `build:release` (clean rebuild + `dist/BUILD_SHA` sentinel) is for official releases.
> For routine fork deploys, plain `npm run build` is enough.

### 3. Snapshot the current dist (rollback point)

Before rsync, back up the running bundle so you can roll back in seconds:

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164 \
  'cp -a /usr/lib/node_modules/omniroute/dist \
     /usr/lib/node_modules/omniroute/dist.bak.<NEW_COMMIT>-pre && echo BACKUP_OK'
```

Naming convention: `dist.bak.<commit-being-deployed>-pre`.
Example: `dist.bak.680b8c00c-pre`.

> Backups are ~750 MB each. Prune old ones occasionally (`rm dist.bak.*` keeping the last 1–2).

### 4. rsync the new bundle

```bash
rsync -az --delete --exclude '/logs/' \
  -e "ssh -i ~/.ssh/t1_fetcher_ed25519 -o ConnectTimeout=20" \
  .build/next/standalone/ \
  ubuntu@161.33.162.164:/usr/lib/node_modules/omniroute/dist/ \
  --stats
```

**Why each flag matters:**

| Flag                   | Why                                                                     |
| ---------------------- | ----------------------------------------------------------------------- |
| `-a`                   | Archive mode (preserve perms, symlinks, recursive)                      |
| `-z`                   | Compress during transfer                                                |
| `--delete`             | Remove files in remote `dist/` that no longer exist locally (true sync) |
| `--exclude '/logs/'`   | **Do not delete** the runtime logs directory                            |
| trailing `/` on source | Sync the _contents_ of standalone, not the folder itself                |

Exit 0 = success. Note the `speedup` line (high number = mostly matched blocks = cheap transfer).

### 5. chown + restart

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164 '
  sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute/dist && \
  sudo systemctl restart omniroute.service && \
  sleep 4 && \
  systemctl is-active omniroute.service && \
  systemctl --no-pager --lines=5 status omniroute.service
'
```

**Why chown:** if you ever rsync'd as root (or a global `npm install -g` ran as root), files
land `root:root` and the `ubuntu` service user gets `EACCES` on lazy native-binary downloads
(`tls-client-node`, `sqlite-vec`). `chown -R ubuntu:ubuntu` fixes it. (See `FORK_NOTES.md` OPS-002.)

### 6. Verify the deploy

Run these on the VPS. A healthy deploy passes ALL of them.

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164 '
  echo "=== service ==="
  systemctl is-active omniroute.service

  echo "=== health (expect AUTH_001 JSON, NOT 502/empty) ==="
  curl -s -m 10 http://127.0.0.1:80/api/health | head -c 300

  echo ""
  echo "=== your new code is in the bundle? ==="
  grep -rIl "<a-marker-from-your-change>" /usr/lib/node_modules/omniroute/dist/.build/next/server/ | head

  echo "=== errors in recent logs? ==="
  sudo journalctl -u omniroute.service --since "2 min ago" --no-pager | \
    grep -iE "error|fail|exception|cannot|undefined" || echo "NO_ERRORS"
'
```

**How to read the health check:**

- `{"error":{"code":"AUTH_001",...}}` → **healthy.** The endpoint requires auth; a clean
  JSON AUTH error (not a 502, not an empty body) proves the server is up and routing.
- Empty body / 502 / connection refused → **unhealthy.** Check journalctl, check port 80,
  and confirm the entry point resolves: `readlink -f /usr/bin/omniroute` should point at
  `…/omniroute/bin/omniroute.mjs`, and the bundle it launches (`dist/server.js`) should exist.

**How to verify your change is live:**
Pick a literal string your change introduced and grep the compiled bundle. Note the path is
`dist/.build/next/server/chunks/` (the build `distDir` is `.build/next`, not `.next`).
Example checks from the `680b8c00c` ponytail deploy:

```bash
# Ponytail marker present?
grep -rIo "OmniRoute Ponytail" /usr/lib/node_modules/omniroute/dist/.build/next/server/ | wc -l
# Per-engine analytics field present?
grep -rIl "augmentationTokens" /usr/lib/node_modules/omniroute/dist/.build/next/server/ | wc -l
```

### 7. Smoke test through the public endpoint

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

If the new build is broken, roll back to the snapshot from Step 3:

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164 '
  sudo systemctl stop omniroute.service
  sudo rm -rf /usr/lib/node_modules/omniroute/dist
  sudo mv /usr/lib/node_modules/omniroute/dist.bak.<NEW_COMMIT>-pre \
          /usr/lib/node_modules/omniroute/dist
  sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute/dist
  sudo systemctl start omniroute.service
  sleep 3
  systemctl is-active omniroute.service
'
```

Replace `<NEW_COMMIT>` with the SHA you rolled out (the backup is named after what was _about_
to replace it). Then re-point origin/branch if needed (usually not — rollback is a runtime
operation, not a git operation).

---

## Troubleshooting

| Symptom                                         | Likely cause                                            | Fix                                                                            |
| ----------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `curl :80/api/health` → empty / 502             | Service not up or wrong port                            | `systemctl status omniroute.service`; confirm `PORT=80` in `.env` / unit       |
| Service crashes on start, `EACCES` in logs      | `dist/` owned by root (lazy native download)            | `sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute`                  |
| Externally unreachable on :80 but works locally | Oracle iptables REJECT rule above ACCEPT                | insert TCP 80 ACCEPT above the catch-all REJECT (see `FORK_NOTES.md` OPS-001)  |
| `https://jebo.ai` 403s / blocks Anthropic SDK   | Cloudflare AI bot detection                             | disable CF AI bot detection for `jebo.ai` (see `FORK_NOTES.md` OPS-003)        |
| Your change grep returns 0 hits                 | Wrong path (`dist/.next/...` vs `dist/.build/next/...`) | grep `dist/.build/next/server/`                                                |
| Build fails on Mac                              | Node version / deps                                     | ensure Node `>=22`; `npm ci`                                                   |
| rsync transfers full 700 MB every time          | forgot `--delete` delta flags or source trailing `/`    | use exact command from Step 4                                                  |
| OOM crash: `FATAL ERROR: … heap out of memory`  | V8 heap limit too low for the bundle size               | set `OMNIROUTE_MEMORY_MB=768` in drop-in (CLI reads this, not NODE_OPTIONS)    |
| "Server is unreachable. Reconnecting…" in UI    | OOM crash → auto-restart → cold start (~8–15s downtime) | check `journalctl -u omniroute.service` for heap/OOM; fix per row above        |
| `Cannot find module './chunks/NNNNN.js'` (500s) | Corrupted page chunks from `npm install` in `dist/`     | clean-build (`rm -rf .build && npm run build`), redeploy; never npm in `dist/` |

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

---

## Reference: deploy command chain (copy-paste)

> Replace `<COMMIT>` with the short SHA you are deploying.

```bash
# 1. Build
npm run build

# 2. Snapshot (rollback point)
ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164 \
  "cp -a /usr/lib/node_modules/omniroute/dist /usr/lib/node_modules/omniroute/dist.bak.<COMMIT>-pre && echo BACKUP_OK"

# 3. rsync
rsync -az --delete --exclude '/logs/' \
  -e "ssh -i ~/.ssh/t1_fetcher_ed25519 -o ConnectTimeout=20" \
  .build/next/standalone/ \
  ubuntu@161.33.162.164:/usr/lib/node_modules/omniroute/dist/ --stats

# 4. chown + restart
ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164 \
  'sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute/dist && sudo systemctl restart omniroute.service && sleep 4 && systemctl is-active omniroute.service'
```
