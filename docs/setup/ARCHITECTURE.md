# Architecture

This repository is an **operational notebook** for a self-hosted OmniRoute AI gateway — it does not contain the gateway source. OmniRoute is the upstream npm package `omniroute`; this repo tracks the deployment on Oracle Cloud. The "architecture" below is the **deployment architecture** of the running system, not a software architecture diagram.

## Pattern Overview

**Overall:** Single-tenant, single-process AI gateway fronted by a reverse-proxy CDN, with a self-hosted admin dashboard co-located on the same process.

**Key Characteristics:**

- One VM, one systemd-managed Node.js process — no container, no orchestrator
- Cloudflare edge terminates TLS (Flexible mode), origin serves plain HTTP on TCP/80
- All provider API keys are stored server-side; clients authenticate with a single OmniRoute admin key
- One OpenAI-compatible endpoint (`/v1`) fronts 231+ LLM providers with routing, fallbacks, and caching handled by OmniRoute

## Layers

**Client Tools (off-box):**

- Purpose: Issue OpenAI-compatible chat/completion requests to the gateway
- Location: off-host (Claude Code, Codex, Aider, pi, custom zsh helpers `glm()` / `kimicc()` / `minimax()`)
- Contains: OpenAI-compatible HTTP clients
- Depends on: `https://jebo.ai/v1` + admin API key (Bearer)
- Used by: the operator's local shell

**Cloudflare Edge (off-box):**

- Purpose: DNS resolution for `jebo.ai`, TLS termination, edge caching
- Location: Cloudflare free tier (DNS A record `@ → 161.33.162.164`, orange-cloud proxied, SSL/TLS mode = Flexible)
- Contains: DNS records, edge TLS cert, Flexible-SSL config
- Depends on: public IP of the VM
- Used by: every inbound request to `https://jebo.ai`

**Oracle Cloud Networking (off-box, vendor-managed):**

- Purpose: VM-level ingress control at the hypervisor
- Location: Oracle Cloud Console → VCN `vcn-20260624-1529` → Subnet `subnet-20260624-1529` → Default Security List
- Contains: one ingress rule `0.0.0.0/0 → TCP:80`
- Depends on: VCN + subnet attached to `nic1`
- Used by: inbound traffic to the VM's public IP

**Host Firewall (on-box):**

- Purpose: Kernel-level packet filter; Oracle's Ubuntu image ships a catch-all REJECT
- Location: `/etc/iptables/rules.v4` (persisted via `netfilter-persistent`); live rules via `iptables`
- Contains: one ACCEPT rule for TCP/80 inserted at position 5, **before** the catch-all REJECT
- Depends on: `iptables`, `netfilter-persistent`
- Used by: the Linux kernel for all inbound packets

**OmniRoute Process (on-box):**

- Purpose: AI gateway — OpenAI-compatible request routing, provider fan-out, caching, fallbacks, admin dashboard
- Location: `/usr/lib/node_modules/omniroute` (global npm install), running as the `ubuntu` user under systemd unit `/etc/systemd/system/omniroute.service`
- Contains: Node.js 22 runtime + the `omniroute` package + native dependency `tls-client-node`
- Depends on: Node 22+ (from NodeSource), `STORAGE_ENCRYPTION_KEY` in `~/.omniroute/.env`
- Used by: inbound requests to port 80

**Upstream LLM Providers (off-box, vendor-managed):**

- Purpose: Source LLMs (Anthropic, OpenAI, Google, Z.AI, Kimi, 231+ more)
- Location: each provider's own API endpoint
- Contains: vendor APIs
- Depends on: provider API keys stored in OmniRoute's encrypted store
- Used by: the OmniRoute process when forwarding requests

## Data Flow

**Chat Request Flow:** (client → response)

1. Client tool sends `POST https://jebo.ai/v1/chat/completions` with `Authorization: Bearer $OMNIROUTE_KEY` — `~/.zshrc` (`glm()`, `kimicc()`, `minimax()` helpers)
2. Cloudflare edge resolves `jebo.ai → 161.33.162.164`, terminates TLS, opens a plain-HTTP connection to the origin on TCP/80
3. Oracle security list allows the inbound TCP/80 packet to reach the VM's `eth0`
4. Linux kernel `iptables` ACCEPT rule (position 5, before the catch-all REJECT) passes the packet to the listening socket
5. OmniRoute (`/usr/bin/omniroute`, port 80, capability `cap_net_bind_service`) accepts the connection, validates the Bearer key, and resolves the model to one of 231+ upstream providers
6. OmniRoute forwards the request to the upstream provider's API using the provider's API key from its encrypted store
7. Upstream returns the completion; OmniRoute applies routing/fallbacks/caching, then streams the response back to the client

**Admin Dashboard Flow:**

1. Operator opens `http://jebo.ai:20128` (direct, post-`iptables`) or the proxied path
2. Same OmniRoute process serves the dashboard on port `20128` (the package default; the systemd unit overrides `PORT=80` only for the gateway, dashboard stays on `20128`)
3. Operator generates the first admin API key via the dashboard UI; key is stored encrypted in `~/.omniroute/.env`

**Boot Flow:**

1. systemd starts `/etc/systemd/system/omniroute.service` as user `ubuntu` with env `PORT=80 REQUIRE_API_KEY=true HOST=0.0.0.0`
2. Node process binds TCP/80 via the pre-set `cap_net_bind_service` file capability on `/usr/bin/node`
3. After ~9 s the service is ready (`sleep 10` in install); `/v1/models` returns `AUTH_002` until a key is presented

## Key Abstractions

**OmniRoute Gateway:**

- Purpose: A single OpenAI-compatible endpoint that fronts 231+ LLM providers with smart routing, fallbacks, caching, and an admin dashboard
- Location: upstream npm package `omniroute` v3.8.37, installed at `/usr/lib/node_modules/omniroute`
- Pattern: Adapter/fan-out over multiple vendor APIs behind one stable interface

**Admin API Key (Bearer token):**

- Purpose: Authenticates client tools to the gateway; generated once in the dashboard, used as `Authorization: Bearer $OMNIROUTE_KEY`
- Location: stored in password manager locally; stored encrypted in `~/.omniroute/.env` on the VM
- Pattern: Shared-secret bearer auth; `REQUIRE_API_KEY=true` makes the gateway 401 on any request without a valid key

**systemd Unit `omniroute.service`:**

- Purpose: Declares the process lifecycle, env, and restart policy for the gateway
- Location: `/etc/systemd/system/omniroute.service` on `nic1`
- Pattern: Declarative service unit; `Restart=on-failure` + `RestartSec=5`

**STORAGE_ENCRYPTION_KEY:**

- Purpose: Encrypts provider API keys at rest in OmniRoute's local store
- Location: `~/.omniroute/.env` on the VM, created by `omniroute doctor`
- Pattern: Symmetric key file, never committed

**setcap on `/usr/bin/node`:**

- Purpose: Allows the Node binary to bind privileged port 80 without running as root
- Location: applied once with `sudo setcap cap_net_bind_service=+ep /usr/bin/node`
- Pattern: Linux capabilities (no `sudo`/setuid wrapper needed)

## Entry Points

**HTTPS Gateway (production):**

- Location: `https://jebo.ai/v1` (Cloudflare Flexible, terminates TLS at edge)
- Triggers: every OpenAI-compatible client tool
- Responsibilities: serves `/v1/chat/completions`, `/v1/models`, etc.; enforces Bearer auth

**HTTP Gateway (origin-direct, debug):**

- Location: `http://161.33.162.164/v1` (bypasses Cloudflare)
- Triggers: local sanity checks via `curl` from the operator's machine
- Responsibilities: same as production entry, but without the edge in the path

**Loopback Gateway (on-box, debug):**

- Location: `http://localhost:80/v1` (and `http://localhost:20128` for the dashboard)
- Triggers: `curl` from the VM over SSH
- Responsibilities: bypasses both Cloudflare and Oracle's ingress; useful to isolate faults

**Admin Dashboard:**

- Location: `http://jebo.ai:20128` (and `http://nic1:20128` on the LAN `10.0.0.0/...`)
- Triggers: operator browser session
- Responsibilities: API-key generation, provider-key onboarding, model/usage visibility

**SSH:**

- Location: `ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164` (or `ssh nic1` after the `~/.ssh/config` alias is added)
- Triggers: operator maintenance
- Responsibilities: full operator access; runs all `sudo` operations (firewall, systemd, npm install)

## Error Handling

**Strategy:** Fail closed.

- **Auth:** `REQUIRE_API_KEY=true` → any request without a valid Bearer key returns `401` (OmniRoute code `AUTH_002` for `/v1/models`). No anonymous traffic reaches upstream providers.
- **Firewall ordering:** Oracle's default iptables chain ends in a catch-all REJECT. The TCP/80 ACCEPT must be inserted **above** that REJECT (`-I INPUT 5`); inserting at position 6 makes the ACCEPT unreachable and external traffic gets RST'd. Always verify with `sudo iptables -L INPUT -n --line-numbers`.
- **Restart on crash:** systemd `Restart=on-failure` + `RestartSec=5` — the process respawns automatically after a crash; boot is ~9 s.
- **Memory pressure:** 1 GB RAM VM runs with 2 GB swap file persisted in `/etc/fstab` and `vm.swappiness=10` to keep the working set in RAM.
- **npm install ownership trap:** `sudo npm install -g omniroute@latest` re-roots the install dir to `root`, which breaks lazy downloads by the systemd service (e.g. `tls-client-node`'s native binary). The required fix is `sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute && sudo systemctl restart omniroute`.
- **TLS posture:** Cloudflare Flexible means Cloudflare-edge ↔ origin traffic is plaintext on port 80. The dashboard on port `20128` is also plaintext. Both are acceptable for a personal gateway but are documented as upgradable to Full (strict) via a Cloudflare Origin cert + reverse proxy.

## Cross-Cutting Concerns

**Logging:** `journalctl -u omniroute` (live: `journalctl -u omniroute -f`); systemd unit sets `StandardOutput=journal` and `StandardError=journal`. `omniroute doctor` for provider/port/native-dep diagnostics.

**Caching:** OmniRoute's built-in response cache, enabled and configured through the admin dashboard. Provider selection (smart routing, fallbacks) is also a OmniRoute-internal concern, not configured at the host level.

**Storage:**

- Provider API keys: encrypted at rest with `STORAGE_ENCRYPTION_KEY` in `~/.omniroute/.env` (created by `omniroute doctor`).
- Admin API key: in the operator's password manager, **never** committed to this repo or to `README.md`.
- `README.md` is the only file in this repo and contains no secrets.

**Identity & auth:** One admin API key is the only credential issued to client tools. All upstream provider keys are entered once via the dashboard and live in the encrypted store on the VM.

**Persistence across reboots:** iptables rules are persisted with `netfilter-persistent`; swap is in `/etc/fstab`; the systemd unit is `systemctl enable`d; no other host state needs to survive a restart.
