# omniroute-setup

Self-hosted [**OmniRoute**](https://github.com/diegosouzapw/OmniRoute) AI gateway on Oracle Cloud, fronted by the **`jebo.ai`** domain.

OmniRoute is an open-source AI gateway: a single OpenAI-compatible endpoint that fronts **231+ LLM providers** (Anthropic, OpenAI, Google, Z.AI, Kimi, etc.) with smart routing, fallbacks, caching, and an admin dashboard. Add all your provider API keys once on the server, then point every tool (Claude Code, Codex, Aider, pi, …) at one URL + one key.

---

## 🚦 Status

| Stage                                                                                                                          | State    |
| ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Server provisioned (`nic1` / `161.33.162.164`)                                                                                 | done     |
| SSH key (`t1_fetcher_ed25519`) provisioned                                                                                     | done     |
| 2 GB swap file created + persisted in `/etc/fstab`, `vm.swappiness=10`                                                         | done     |
| Domain `jebo.ai` DNS → `161.33.162.164` (Cloudflare A record, orange cloud)                                                    | done     |
| OmniRoute installed (v3.8.37, systemd unit, listening on 0.0.0.0:80)                                                           | done     |
| `REQUIRE_API_KEY=true` enforced (401 without valid Bearer)                                                                     | done     |
| Oracle security list: ingress rule `0.0.0.0/0 → TCP:80` added                                                                  | done     |
| VM iptables: ACCEPT for TCP 80 inserted BEFORE the catch-all REJECT (Oracle's default image ships REJECT-all-except-SSH first) | done     |
| Cloudflare SSL/TLS mode = **Flexible** (edge TLS → origin plain HTTP :80)                                                      | done     |
| **`https://jebo.ai` reachable, returns 401 without key**                                                                       | **done** |
| First admin API key generated in dashboard                                                                                     | pending  |
| (optional) Rebuild as ARM `A1.Flex` 1 OCPU / 2 GB when capacity available                                                      | pending  |

---

## 🔑 Server connection

|                    |                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Public IP          | `161.33.162.164`                                                                                                                        |
| Internal IP        | `10.0.0.152`                                                                                                                            |
| Hostname           | `nic1`                                                                                                                                  |
| OS                 | Ubuntu 24.04 LTS (Oracle Cloud VM, 1 vCPU / 1 GB RAM / 45 GB) — `VM.Standard.E2.1.Micro` (Always Free, **fixed shape, not upgradable**) |
| SSH user           | `ubuntu`                                                                                                                                |
| SSH key (local)    | `~/.ssh/t1_fetcher_ed25519`                                                                                                             |
| OmniRoute port     | `20128` (gateway + dashboard on the same port)                                                                                          |
| Dashboard (direct) | `http://jebo.ai:20128` _(once DNS + firewall are open)_                                                                                 |

**Connect:**

```bash
ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164
```

**Recommended: add an SSH config alias** so future sessions are just `ssh nic1`:

```sshconfig
Host nic1
  HostName 161.33.162.164
  User ubuntu
  IdentityFile ~/.ssh/t1_fetcher_ed25519
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

Append the block above to `~/.ssh/config`.

---

## 🌐 Domain setup (`jebo.ai` → this server)

The domain is managed in **Cloudflare**. Steps to wire it up:

1. In Cloudflare DNS for `jebo.ai`, add an **A record**:
   - Name: `@`
   - IPv4: `161.33.162.164`
   - Proxy: **Proxied** (orange cloud)
2. In Cloudflare **SSL/TLS → Overview**, set encryption mode to **Flexible** (since OmniRoute speaks plain HTTP on origin port 80; the edge does TLS, origin is plain).
3. In **Oracle Cloud Console**, open port **80** on the security list attached to `subnet-20260624-1529`:
   - Networking → VCN → `vcn-20260624-1529` → Subnets → `subnet-20260624-1529` → Security Lists → Default Security List
   - **Add Ingress Rules:** Source `0.0.0.0/0`, Protocol TCP, Destination Port `80`

### On the VM: open port 80 in iptables

Oracle's Ubuntu cloud image ships iptables with a catch-all REJECT rule. Port 80 must be inserted **before** that REJECT (rule order matters; first match wins):

```bash
ssh ubuntu@161.33.162.164
sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT   # position 5, NOT 6
sudo netfilter-persistent save
```

> ⚠️ **Trap to avoid:** `iptables -I INPUT 6` would insert AFTER the catch-all REJECT (which sits at position 5 in Oracle's default ruleset) — the ACCEPT would be unreachable and external traffic would still get RST'd ("Connection refused"). Always run `sudo iptables -L INPUT -n --line-numbers` after any insert to confirm the new rule sits **above** the REJECT.

---

## 📦 Install (run on `nic1` over SSH)

```bash
# Node 22+ is required (Ubuntu 24.04 ships Node 20)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v   # confirm ≥ 22

# OmniRoute (npm install pulls ~5 GB of deps and takes 10–15 min on a 1 GB VM)
sudo npm install -g omniroute
omniroute doctor   # creates STORAGE_ENCRYPTION_KEY in ~/.omniroute/.env

# Bind privileged port 80 without running as root
sudo setcap cap_net_bind_service=+ep /usr/bin/node

# systemd unit (port 80, REQUIRE_API_KEY=true)
sudo tee /etc/systemd/system/omniroute.service >/dev/null <<'EOF'
[Unit]
Description=OmniRoute AI gateway
After=network.target

[Service]
Type=simple
User=ubuntu
Environment=PORT=80
Environment=REQUIRE_API_KEY=true
Environment=HOST=0.0.0.0
# Override OmniRoute's hardcoded 127.0.0.1:20128 fallback URLs so internal forwarding
# (rerank, vision bridge, MITM, MCP server) hits THIS instance on port 80, not 20128.
# Without these, internal features return ECONNREFUSED → 502 to API clients.
Environment=OMNIROUTE_BASE_URL=http://127.0.0.1:80
Environment=NEXT_PUBLIC_BASE_URL=http://localhost:80
Environment=BASE_URL=http://localhost:80
Environment=OMNIROUTE_PUBLIC_BASE_URL=https://jebo.ai
Environment=NEXT_PUBLIC_APP_URL=https://jebo.ai
ExecStart=/usr/bin/omniroute
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now omniroute
sudo systemctl status omniroute   # should be active (running)
sleep 10                           # boot takes ~9 s
curl -sS http://localhost:80/v1/models   # should return AUTH_002 (no key)
```

After boot, `https://jebo.ai` is reachable (no port in the URL — Cloudflare Flexible SSL handles the TLS at the edge).

> 🔒 **Never commit the API key to this README or to git.** Generate it in the dashboard, store it in your password manager, and if it ever leaks, rotate it from the dashboard. The gateway is exposed on the public internet — `REQUIRE_API_KEY=true` is mandatory.

---

## 🔌 Using OmniRoute from your tools

Once an **admin API key** is generated in the dashboard (`Settings → API Keys`), point any OpenAI-compatible client at:

- **Base URL:** `https://jebo.ai/v1`
- **API key:** the key generated in the dashboard

> 🔒 **Never commit the API key to this README or to git.** Generate it in the dashboard, store it in your password manager, and if it ever leaks, rotate it from the dashboard. The gateway is exposed on the public internet — `REQUIRE_API_KEY=true` is mandatory.

### One-off sanity check

```bash
curl -s https://jebo.ai/v1/models \
  -H "Authorization: Bearer $OMNIROUTE_KEY" | jq '.data | length'
```

Should return the number of provider models OmniRoute knows about.

### Wiring into Claude Code / pi / Codex

Replace the `ANTHROPIC_BASE_URL` (or the tool's equivalent) with `https://jebo.ai` and set `ANTHROPIC_AUTH_TOKEN` to the OmniRoute key. See `~/.zshrc` for the existing `glm()` / `kimicc()` / `minimax()` patterns — the same shape works.

---

## 📁 This folder

This repo is the **operational notebook** for the deployment, not the gateway code itself (OmniRoute lives upstream). Things to drop in here as we go:

- `cloudflare/` — DNS screenshots / config snippets
- `systemd/` — service unit overrides (if we tune it)
- `notes/` — provider quirks, model routing rules, outage log
- `CHANGELOG.md` — version bumps of OmniRoute on the server

---

## 🧰 Quick reference

```bash
# SSH
ssh -i ~/.ssh/t1_fetcher_ed25519 ubuntu@161.33.162.164

# Service
sudo systemctl status omniroute
sudo systemctl restart omniroute
sudo journalctl -u omniroute -f        # live logs

# Update OmniRoute
sudo npm install -g omniroute@latest && sudo chown -R ubuntu:ubuntu /usr/lib/node_modules/omniroute && sudo systemctl restart omniroute
# ↑ the chown is required: `npm install -g` (run as root) re-roots the install dir,
#   which breaks any subsequent lazy-downloads from the systemd service running as ubuntu
#   (e.g. tls-client-node's native binary at dist/node_modules/tls-client-node/bin/).

# Doctor
omniroute doctor                       # diagnose providers, ports, native deps
```

---

## 📋 Open items / TODOs

**Remaining:**

- [ ] Generate first admin API key in dashboard, store in password manager
- [ ] Verify `curl -H "Authorization: Bearer $KEY" https://jebo.ai/v1/models` works end-to-end
- [ ] Re-point existing `glm()` / `kimicc()` / `minimax()` zsh functions at the OmniRoute base URL (`https://jebo.ai`)
- [ ] Set up a daily `omniroute update` reminder (or watch the upstream releases)

**Optional / later:**

- [ ] (capacity-gated) Rebuild as ARM `VM.Standard.A1.Flex` 1 OCPU + 2 GB on Always Free — uses 1 of the 2 OCPUs / 2 of 12 GB free tier ARM quota. Capacity is often "Out of host capacity" in busy regions; retry from console until slot opens.
- [ ] (optional) Upgrade TLS from Flexible (Cloudflare→origin is plaintext) to **Full (strict)** with a Cloudflare Origin cert + nginx/Caddy in front of OmniRoute — gives end-to-end TLS at the cost of ~5 min more setup. The current Flexible mode is fine for a personal gateway; the leg between Cloudflare's edge and nic1 is not encrypted.
- [ ] (optional) Replace OmniRoute-on-port-80 with a `cloudflared` tunnel (zero inbound ports on Oracle, free TLS at edge, smaller attack surface). Trade-off: a tunnel daemon must stay alive and adds Cloudflare as an extra dependency.
