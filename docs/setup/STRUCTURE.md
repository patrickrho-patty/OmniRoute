# Codebase Structure

## Directory Layout

```
omniroute-setup/
└── README.md            # Operational notebook — the only file in the repo
```

The repo currently contains exactly one file. The directory structure below describes **the planned layout** called out in `README.md` (`📁 This folder`), not the current state — these subdirectories do not exist yet and should be created as the deployment matures.

```
omniroute-setup/
├── README.md                # Operational notebook (this repo's source of truth)
├── cloudflare/              # DNS screenshots / config snippets for jebo.ai
├── systemd/                 # Service unit overrides (when the unit is tuned)
├── notes/                   # Provider quirks, model routing rules, outage log
└── CHANGELOG.md             # Version bumps of OmniRoute on the server
```

## Directory Purposes

**`README.md`:**

- Purpose: Single source of truth for the deployment — status table, server connection details, domain setup, install procedure, client-tool wiring, open items
- Contains: Markdown only; no scripts, no config
- Key files: `README.md`

**`cloudflare/`** \*(planned):\*\*

- Purpose: Capture the Cloudflare-side configuration for `jebo.ai` (DNS A record, SSL/TLS Flexible mode, any future origin cert or tunnel config)
- Contains: Screenshots, exported zone snippets, `cloudflared` config if a tunnel is adopted later
- Key files: (none yet)

**`systemd/`** \*(planned):\*\*

- Purpose: Track changes to `/etc/systemd/system/omniroute.service` — environment overrides, memory limits, restart tuning
- Contains: Drop-in unit snippets (e.g. `override.conf`), notes on what was changed and why
- Key files: (none yet)

**`notes/`** _(planned):_

- Purpose: Operator memory for the live system — provider quirks, model routing rules, outage log, capacity-gated migration notes
- Contains: Free-form markdown; one file per topic or one chronological log, per convention
- Key files: (none yet)

**`CHANGELOG.md`** _(planned):_

- Purpose: Record OmniRoute version bumps on the server (e.g. `omniroute@3.8.37` → `3.8.38`) and any post-upgrade action taken (e.g. the `chown -R ubuntu:ubuntu` fix-up)
- Contains: Keep-a-Changelog-style entries
- Key files: (none yet)

## Key File Locations

**Operational source of truth:** `README.md` — every status, command, and architectural decision lives here. When in doubt, `README.md` is canonical and `ARCHITECTURE.md` reflects it.

**Configuration (remote, not in this repo):**

- `~/.ssh/t1_fetcher_ed25519` (local) — SSH private key for `ubuntu@nic1`
- `~/.ssh/config` (local) — should contain the `Host nic1` alias block
- `~/.omniroute/.env` (on `nic1`) — `STORAGE_ENCRYPTION_KEY` and the admin API key
- `/etc/systemd/system/omniroute.service` (on `nic1`) — service unit (PORT=80, REQUIRE_API_KEY=true)
- `/etc/iptables/rules.v4` (on `nic1`) — persisted firewall rules (ACCEPT TCP/80 at position 5, before catch-all REJECT)
- `/etc/fstab` (on `nic1`) — swap file entry

**Core gateway code:** upstream npm package `omniroute` v3.8.37, installed at `/usr/lib/node_modules/omniroute` on `nic1`. **Not in this repo.**

**Admin API key:** generated in the dashboard, stored in the operator's password manager, used as `Authorization: Bearer $OMNIROUTE_KEY` by client tools. **Never** in this repo, **never** in `README.md`.

**Tests:** none. This repo is a deployment notebook, not a software project; the "tests" are the sanity checks embedded in `README.md` (`curl /v1/models`, dashboard reachability, end-to-end key check).

## Naming Conventions

**Files:** lowercase, hyphenated where multi-word (e.g. `CHANGELOG.md`, no other examples yet). New notes should follow the same style — e.g. `notes/outage-2026-06-27.md`, `notes/provider-quirks-zai.md`.

**Directories:** lowercase, single-word or short plural (`cloudflare/`, `systemd/`, `notes/`). No nested subdirectories are planned.

**Markdown headings:** ATX-style (`#`, `##`), one H1 per file, mirroring `README.md`'s structure (Status, Connection, Domain, Install, Usage, Open Items).

## Where to Add New Content

This is a documentation repo, not a code repo — "where to add new code" maps to "where to add new notes".

**New provider quirk or routing rule:** `notes/provider-[name].md` — one file per provider (e.g. `notes/provider-anthropic.md`, `notes/provider-zai.md`).
**New outage or incident:** `notes/outage-YYYY-MM-DD.md` — date-stamped chronological log.
**New Cloudflare config or screenshot:** `cloudflare/[topic].md` or `cloudflare/[topic].png` — group by Cloudflare feature (DNS, SSL/TLS, tunnel).
**New systemd unit override or tuning note:** `systemd/override-[reason].conf` plus a short `systemd/override-[reason].md` explaining the change.
**New OmniRoute version bump:** add an entry to `CHANGELOG.md` at the top, under a new `## [version] - YYYY-MM-DD` heading. Include the `chown -R ubuntu:ubuntu` fix-up if the install was a `npm install -g`.
**New open item or TODO:** append to the `## 📋 Open items / TODOs` section in `README.md`; do not duplicate in `ARCHITECTURE.md` — keep "what's done" in `ARCHITECTURE.md` and "what's still to do" in `README.md`.

**Do not add:**

- Secrets, API keys, or tokens — even in examples
- `node_modules/`, build artifacts, or screenshots larger than ~500 KB (link externally instead)
- Any file under `.planning/` — `magic-context` writes only to the project root, never to `.planning/`

**Verify before writing:** re-read `README.md` for current status; re-read `ARCHITECTURE.md` for current architecture. Both must stay in sync — if you change a status in one, update the other.
