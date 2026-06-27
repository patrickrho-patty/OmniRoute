# FORK_NOTES.md — OmniRoute fork and deployment customizations

This is the canonical record of **what we changed or configured that is not present in upstream OmniRoute**.

It covers two classes of change:

1. **Fork source changes** — committed code in `patrickrho-patty/OmniRoute`, branch `custom-features`.
2. **Operational/client customizations** — live-server config, Cloudflare setup, pi/OpenCode configs, and migration scripts. These are not upstream source commits, so their "commit" field is marked **external state / no repo commit**.

Keep this file updated whenever we add a new fork-only source patch or a production/client customization that future migrations depend on.

---

## Current git state

| Item                                | Value                                           |
| ----------------------------------- | ----------------------------------------------- |
| Upstream repo                       | `github.com/diegosouzapw/OmniRoute`             |
| Fork remote                         | `git@github.com:patrickrho-patty/OmniRoute.git` |
| Fork branch carrying source patches | `custom-features`                               |
| Upstream baseline                   | `555b21d29` — `Release v3.8.37 (#5053)`         |
| Fork source patch commit            | `9b374c5870caebf1a7f0ff9f260d60ce7ab98613`      |
| Source divergence                   | 1 commit ahead of upstream v3.8.37              |
| Source files changed by fork        | 7                                               |
| Source diff stat                    | +50 / −11                                       |
| Pushed to GitHub                    | Yes — `custom-features` pushed to origin        |

`main` in this fork is intentionally kept identical to upstream `main`; our deploy branch is `custom-features`.

---

## Source changes unique to this fork

### SRC-001 — Hardcoded port fallbacks fixed

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Commit            | `9b374c5870caebf1a7f0ff9f260d60ce7ab98613`                    |
| Commit title      | `Fix hardcoded ports + Claude Messages API shape recognition` |
| Date              | 2026-06-27 04:04:47 KST                                       |
| Upstream baseline | `555b21d29` / v3.8.37                                         |
| Status            | Deployed to `jebo.ai`; source pushed to fork                  |

#### Problem

OmniRoute upstream v3.8.37 had several internal loopback/live-WS call sites with literal fallback ports:

- `20128` for the main API/dashboard listener
- `20129` for the live-WS sidecar

That broke our deployment because `jebo.ai` runs OmniRoute on **port 80** behind Cloudflare Flexible SSL, not on the upstream default `20128`.

#### Root cause

`src/lib/runtime/ports.ts` already existed upstream, but several newer call sites bypassed it and used hardcoded literals.

#### Fix

The fork routes those call sites through `getRuntimePorts()`:

| File                                              | Fork change                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | --- | -------- |
| `open-sse/handlers/chatCore/telemetryHelpers.ts`  | Uses `getRuntimePorts().liveWsPort` instead of `process.env.LIVE_WS_PORT               |     | "20129"` |
| `src/app/api/playground/improve-prompt/route.ts`  | Uses `getRuntimePorts().port` instead of `process.env.PORT ?? "20128"`                 |
| `src/app/api/providers/[id]/sync-models/route.ts` | Uses `getRuntimePorts().port` for two loopback readiness/model-sync call sites         |
| `src/app/api/v1/ws/route.ts`                      | Uses `getRuntimePorts().liveWsPort` for advertised live-WS metadata                    |
| `src/lib/cli-helper/tool-detector.ts`             | Tool-detection heuristic uses the runtime port instead of `localhost:20128`            |
| `src/lib/runtime/ports.ts`                        | Adds live-WS defaulting: `liveWsPort = basePort + 1` unless `LIVE_WS_PORT` is explicit |

Added behavior in `src/lib/runtime/ports.ts`:

```ts
const DEFAULT_LIVE_WS_PORT_OFFSET = 1;

liveWsPort: parsePort(process.env.LIVE_WS_PORT, basePort + DEFAULT_LIVE_WS_PORT_OFFSET),
liveWsPortExplicit: !!process.env.LIVE_WS_PORT,
```

This keeps upstream's historical pairing (`20128` main, `20129` live-WS) while making non-default deployments work (`80` main, `81` live-WS fallback unless overridden).

#### Verification used

After build + deploy to nic1:

- `POST https://jebo.ai/v1/messages` returned HTTP 200 with real Claude text.
- `POST https://jebo.ai/v1/chat/completions` streamed successfully.
- `GET https://jebo.ai/v1/models` returned HTTP 200 with the production `OMNIROUTE_API_KEY`.
- Service was active on port 80 behind Cloudflare Flexible SSL.

---

### SRC-002 — Claude Messages API responses no longer misclassified as malformed

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Commit            | `9b374c5870caebf1a7f0ff9f260d60ce7ab98613`                    |
| Commit title      | `Fix hardcoded ports + Claude Messages API shape recognition` |
| Date              | 2026-06-27 04:04:47 KST                                       |
| Upstream baseline | `555b21d29` / v3.8.37                                         |
| Status            | Deployed to `jebo.ai`; source pushed to fork                  |

#### Problem

`/v1/messages` returned 502 even when the upstream Claude request succeeded. The logs showed valid Claude responses with real `msg_...` IDs, real token counts, and valid text, but OmniRoute still returned 502 to the client.

#### Root cause

`open-sse/utils/diagnostics.ts::detectMalformedNonStream()` only recognized two non-streaming response shapes:

1. Responses API shape: `body.object === "response"` with `body.output[]`
2. Chat Completions shape: `body.choices[]`

Claude Messages API responses use a third shape:

```json
{
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "..." }],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 123, "output_tokens": 45 }
}
```

The discriminator is `type === "message"`, **not** `object === "message"`.

Without a Claude branch, every successful Claude Messages response fell through to the Chat Completions validator, which expected `body.choices[]`. Claude never sets `choices`, so the validator returned `"empty_choices"`, and OmniRoute converted the successful response into a 502.

#### Fix

Added a Claude Messages branch to `detectMalformedNonStream()`:

```ts
if (body.type === "message") {
  const content = body.content;
  const hasOutput =
    Array.isArray(content) &&
    content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string" && (b.text as string).length > 0) return true;
      if (b.type === "tool_use" || b.type === "tool_result") return true;
      return false;
    });
  if (!hasOutput) return "empty_choices";
  return null;
}
```

#### Verification used

After rebuild + deploy:

- `POST https://jebo.ai/v1/messages` returned HTTP 200 with response text `2 + 2 = **4**`.
- `POST https://jebo.ai/v1/chat/completions` streamed SSE chunks successfully.
- The deployed minified bundle contained the `type === "message"` check.
- `GET https://jebo.ai/v1/models` returned HTTP 200 using the production `OMNIROUTE_API_KEY`.

#### Durable rule

If a new response format is added, update `detectMalformedNonStream()` with a shape-specific branch. Otherwise, valid non-OpenAI responses can be misclassified as `empty_choices` and returned as 502.

---

## Production runtime customizations not in upstream source

These changes are required for the current `jebo.ai` deployment, but they are **not source commits** in OmniRoute.

### OPS-001 — Run OmniRoute on port 80 behind Cloudflare Flexible SSL

| Field   | Value                                                      |
| ------- | ---------------------------------------------------------- |
| Commit  | External runtime state / no repo commit                    |
| Host    | `nic1` / `161.33.162.164` currently                        |
| Domain  | `https://jebo.ai`                                          |
| Purpose | Clean HTTPS base URL for coding agents without port suffix |

#### Current architecture

```text
Client → https://jebo.ai/v1 → Cloudflare edge TLS → origin HTTP :80 → OmniRoute
```

Cloudflare SSL mode is **Flexible**. TLS terminates at Cloudflare. The origin server listens on plain HTTP port 80.

#### Required server settings

- `PORT=80` in `omniroute.service`
- `REQUIRE_API_KEY=true`
- `OMNIROUTE_BASE_URL=http://127.0.0.1:80`
- `BASE_URL=http://127.0.0.1:80`
- `NEXT_PUBLIC_BASE_URL=http://127.0.0.1:80`
- `setcap cap_net_bind_service=+ep /usr/bin/node` so non-root Node can bind port 80

#### Required firewall/network settings

- Oracle/host firewall allows inbound TCP 80 from `0.0.0.0/0`
- Local iptables has TCP 80 ACCEPT **above** Oracle Ubuntu's default catch-all REJECT rule
- Cloudflare A record for `jebo.ai` points at the active VPS IP

#### Historical pitfall

On Oracle Ubuntu images, inserting the ACCEPT rule after the default REJECT rule makes port 80 look open locally but unreachable externally. Insert the ACCEPT rule before REJECT.

---

### OPS-002 — `tls-client-node` global-install permission fix

| Field   | Value                                                                             |
| ------- | --------------------------------------------------------------------------------- |
| Commit  | External runtime state / no repo commit                                           |
| Purpose | Allow ChatGPT Web / browser-impersonation providers to download native TLS binary |

Global install with `sudo npm install -g omniroute` leaves `/usr/lib/node_modules/omniroute` owned by `root:root`. OmniRoute service runs as `ubuntu`. `tls-client-node` lazily downloads its native binary into the install tree on first use, so root ownership caused:

```text
EACCES: permission denied, mkdir '/usr/lib/node_modules/omniroute/dist/node_modules/tls-client-node/bin'
```

Required fix after global install or rebuild:

```bash
sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute
```

Migration script `setup-new-vps.sh` bakes this in and also triggers a `tls-client-node` load as `ubuntu` before service start.

---

### OPS-003 — Cloudflare AI bot detection disabled for `jebo.ai`

| Field   | Value                                                               |
| ------- | ------------------------------------------------------------------- |
| Commit  | External Cloudflare state / no repo commit                          |
| Purpose | Stop Cloudflare from blocking Anthropic SDK / Stainless user agents |

Cloudflare's AI bot detection blocked requests from pi because pi uses the official Anthropic SDK, which sends headers like:

```text
User-Agent: Anthropic/JS 0.91.1
X-Stainless-...
```

After disabling Cloudflare AI bot detection, these user agents returned HTTP 200:

- `Anthropic/JS 0.91.1`
- `Anthropic/Python 0.91.1`
- `Anthropic/Go 1.0.0`
- full pi-style request with Stainless headers

No OmniRoute source patch was needed for this.

---

### OPS-004 — Live SQLite and secrets are the real production state

| Field          | Value                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Commit         | External server state / no repo commit                                                                           |
| Critical files | `/home/ubuntu/.omniroute/storage.sqlite`, `/usr/lib/node_modules/omniroute/.env`, `/home/ubuntu/.omniroute/.env` |

For migration, source code is not enough. These files carry production state:

| Path                                         | Why it matters                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `/home/ubuntu/.omniroute/storage.sqlite`     | provider connections, API keys, provider nodes, compression combos, settings |
| `/home/ubuntu/.omniroute/storage.sqlite-wal` | pending WAL writes if service is running                                     |
| `/home/ubuntu/.omniroute/.env`               | data-dir/encryption metadata                                                 |
| `/usr/lib/node_modules/omniroute/.env`       | JWT/API-key secrets and OAuth/client settings                                |
| `/etc/systemd/system/omniroute.service`      | port/base-url/runtime flags                                                  |
| iptables rules                               | port 80 external reachability                                                |

Use SQLite `.backup` while the service is stopped or quiesced; do not blindly rsync a live WAL database.

---

## Client/tool customizations not in upstream source

These are local client configs that point coding tools at `jebo.ai`. They are not in the OmniRoute repo and should not be confused with fork source commits.

### CLIENT-001 — pi uses a single additive `omniroute` provider

| Field              | Value                                                  |
| ------------------ | ------------------------------------------------------ |
| Commit             | External client config / no repo commit                |
| Config files       | `~/.pi/agent/models.json`, `~/.pi/agent/settings.json` |
| Base URL           | `https://jebo.ai/v1`                                   |
| API key env syntax | `$OMNIROUTE_API_KEY`                                   |

Important decisions:

- Use one additive provider named `omniroute`, not built-in provider overrides.
- Keep model IDs exactly as OmniRoute exposes them (`cc/...`, `cx/...`, `mm/...`, `gl/...`, `km/...`, etc.).
- Use `api: anthropic-messages` for the routed models, including Codex/ChatGPT-Web models, so pi does not try to validate `OMNIROUTE_API_KEY` as a real OpenAI OAuth JWT.

Current OmniRoute-routed pi models include:

| Model ID                       | Notes                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `cc/claude-opus-4-8`           | Claude Messages API, thinking medium/high/xhigh                                   |
| `cc/claude-opus-4-7`           | Claude Messages API, thinking medium/high/xhigh                                   |
| `cc/claude-opus-4-6`           | Claude Messages API, thinking medium/high/xhigh                                   |
| `cc/claude-sonnet-4-6`         | Claude Messages API, 200K context, thinking medium/high/xhigh                     |
| `mistral/mistral-large-latest` | Added later; no thinking map                                                      |
| `mm/MiniMax-M3`                | Anthropic-compatible route                                                        |
| `gl/glm-5.2`                   | Z.AI custom prefix `gl`; pi `xhigh` maps to OmniRoute/GLM `max`                   |
| `km/kimi-for-coding`           | Kimi custom prefix `km`                                                           |
| `cx/gpt-5.5`                   | Codex route; uses `anthropic-messages` to avoid OpenAI OAuth JWT validation in pi |
| `cgpt-web/gpt-5.5`             | ChatGPT Web route; uses `anthropic-messages`                                      |

#### Pi-specific constraint discovered

Pi's `ThinkingLevel` enum supports:

```text
off, minimal, low, medium, high, xhigh
```

There is no separate `max` thinking level in pi. For GLM 5.2, we map pi's `xhigh` to OmniRoute's `max`.

#### Codex-specific constraint discovered

Pi's `openai-codex-responses` handler expects the API key to be a real OpenAI OAuth JWT with `chatgpt_account_id`. `OMNIROUTE_API_KEY` is a static OmniRoute key, so pi throws:

```text
Failed to extract accountId from token
```

Workaround in config: use `api: anthropic-messages` and let OmniRoute handle Codex OAuth internally.

---

### CLIENT-002 — OpenCode provider renamed and aligned with pi

| Field                  | Value                                   |
| ---------------------- | --------------------------------------- |
| Commit                 | External client config / no repo commit |
| Config file            | `~/.config/opencode/opencode.jsonc`     |
| Provider name          | `omniroute`                             |
| Previous provider name | `9router`                               |
| Base URL               | `https://jebo.ai/v1`                    |
| API key env syntax     | `{env:OMNIROUTE_API_KEY}`               |
| Package                | `@ai-sdk/openai-compatible`             |

OpenCode sends OpenAI-format requests to OmniRoute's `/v1/chat/completions`. It uses variants rather than pi's `thinkingLevelMap`.

Current OpenCode models align with pi's model set:

- `cc/claude-opus-4-8`
- `cc/claude-opus-4-7`
- `cc/claude-opus-4-6`
- `cc/claude-sonnet-4-6`
- `mistral/mistral-large-latest`
- `mm/MiniMax-M3`
- `gl/glm-5.2`
- `km/kimi-for-coding`
- `cx/gpt-5.5`
- `cgpt-web/gpt-5.5`

Variant rules:

- Claude models: medium/high/xhigh
- Codex + ChatGPT-Web GPT-5.5: low/medium/high/xhigh
- GLM 5.2: high + xhigh where xhigh sends `max`
- Mistral Large: no thinking variants

---

## Provider-prefix customizations in OmniRoute DB

These are not source code changes; they live in OmniRoute's SQLite database.

| Prefix | Meaning                                      | Notes                                               |
| ------ | -------------------------------------------- | --------------------------------------------------- |
| `mm/`  | MiniMax custom/provider route                | Clean alias for MiniMax models                      |
| `gl/`  | Z.AI / GLM custom Anthropic-compatible route | Replaces ugly `anthropic-compatible-<uuid>/...` IDs |
| `km/`  | Kimi custom Anthropic-compatible route       | Replaces ugly `anthropic-compatible-<uuid>/...` IDs |

Key discovery: custom Anthropic-compatible provider rows have editable `provider_nodes.prefix`. The dashboard's compatible-node editor can change the catalog prefix, which is why pi/OpenCode can use clean IDs like `gl/glm-5.2` and `km/kimi-for-coding` instead of UUID-prefixed model IDs.

Prefix changes must be preserved by database backup/restore, not by source rebuild.

---

## Migration tooling created locally

These scripts are local operator tooling, not upstream source commits.

| File                                  | Lines | Purpose                                       | Commit                                 |
| ------------------------------------- | ----: | --------------------------------------------- | -------------------------------------- |
| `/Users/patrickrho/nic1-migration.sh` |   189 | Backup nic1 live state to `~/migration/`      | External local script / no repo commit |
| `/Users/patrickrho/setup-new-vps.sh`  |   158 | Restore/build OmniRoute on a fresh Ubuntu VPS | External local script / no repo commit |

### `nic1-migration.sh`

Backs up:

- SQLite DB via `.backup` (not raw live-WAL rsync)
- OmniRoute `.env` files
- `omniroute.service`
- iptables rules
- fstab/swap metadata
- network notes and restore map

Default SSH target:

```text
ubuntu@161.33.162.164
```

Default SSH key:

```text
~/.ssh/t1_fetcher_ed25519
```

### `setup-new-vps.sh`

Restores/builds on a fresh Ubuntu VPS:

1. Installs Node 22
2. Clones `patrickrho-patty/OmniRoute`
3. Checks out `custom-features`
4. Runs `npm install` and `npm run build`
5. Installs globally
6. Restores `.env` files and SQLite DB
7. Applies `setcap` for port 80
8. Installs systemd unit
9. Inserts TCP 80 ACCEPT above REJECT in iptables
10. Starts service and runs local sanity checks

---

## Headroom decision record

No Headroom source change has been committed yet.

What we found:

- OmniRoute's built-in `headroom` engine is only a **SmartCrusher/tabular JSON compaction subset**, not the full upstream Headroom project.
- The dashboard page for `/dashboard/context/headroom` does not persist `minRows` because `headroom` has no settings sub-object in `EngineConfigPage.tsx`; it resets to default `8`.
- Full upstream Headroom adds features OmniRoute does not currently have: lossy SmartCrusher sampler, CodeCompressor, Kompress-base, CacheAligner, IntelligentContext, image compression, wrappers/proxy/MCP tooling.
- Kompress-base is useful but optional; without it, a Headroom sidecar likely fits in 2 GB RAM alongside OmniRoute. With Kompress-base loaded, 4 GB RAM is the safer target.

Current decision:

- Do not add Headroom sidecar yet.
- If we want most of the gain without new infrastructure, the best source patch would be adding a lossy SmartCrusher sampler to OmniRoute's existing `headroom` engine. No commit exists for this yet.

---

## VPS sizing decision record

No source commit.

| Scenario                                              |        RAM guidance |
| ----------------------------------------------------- | ------------------: |
| OmniRoute only, strict minimum                        | 1 GB (works, swaps) |
| OmniRoute only, recommended                           |                2 GB |
| OmniRoute + Headroom sidecar without Kompress-base    |                2 GB |
| OmniRoute + Headroom/Kompress-base or future-proofing |                4 GB |

Current recommendation:

- **2 GB / 1 vCPU / 30 GB** if we do not run Kompress-base.
- **4 GB** if we want room for full Headroom/Kompress-base later.

---

## Rebase procedure for future upstream releases

When upstream releases a new version:

```bash
git fetch upstream

git switch main
git merge upstream/main --ff-only

git switch custom-features
git rebase main
```

After rebase, verify:

```bash
git diff --name-only main..custom-features
# should include only intentional fork files

# Claude Messages branch still exists
grep -n 'body.type === "message"' open-sse/utils/diagnostics.ts

# hardcoded port literals are not back in source
ast-grep --pattern '"20128"' src open-sse || true
ast-grep --pattern '"20129"' src open-sse || true
```

Then build and smoke test:

```bash
npm run build

curl -sS https://jebo.ai/v1/models \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -o /tmp/models.json -w '%{http_code}\n'

curl -sS https://jebo.ai/v1/messages \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"cc/claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"2+2?"}]}' \
  -o /tmp/messages.json -w '%{http_code}\n'
```

---

## Untracked local repo files

These were present when this document was reviewed:

| Path                                               | What it is                 | Commit?                       |
| -------------------------------------------------- | -------------------------- | ----------------------------- |
| `.pi/APPEND_SYSTEM.md`                             | pi runtime/context helper  | No                            |
| `FORK_NOTES.md`                                    | This canonical record      | Yes, recommended              |
| `docs/setup/README.md`                             | Operator setup/runbook doc | Yes, recommended after review |
| `docs/setup/ARCHITECTURE.md`                       | Operator architecture doc  | Yes, recommended after review |
| `docs/setup/STRUCTURE.md`                          | Operator structure doc     | Yes, recommended after review |
| `omniroute-backup-2026-06-26T17-48-48-221Z.sqlite` | Stale DB backup            | No; do not commit DB backups  |

---

## Open items

- [ ] Commit `FORK_NOTES.md` after review.
- [ ] Review and possibly commit `docs/setup/*.md` as operator docs.
- [ ] Decide whether to PR `SRC-001` and `SRC-002` upstream. Both are self-contained.
- [ ] Add a unit/smoke test for Claude Messages API response-shape validation so `detectMalformedNonStream()` cannot regress.
- [ ] If Headroom work resumes, decide between:
  - source patch: add lossy SmartCrusher sampler to OmniRoute's existing engine; or
  - sidecar: run upstream Headroom proxy on the VPS.
