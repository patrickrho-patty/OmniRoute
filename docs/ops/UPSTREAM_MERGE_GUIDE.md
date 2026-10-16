---
title: "Upstream Merge Guide"
version: 3.8.51
lastUpdated: 2026-09-25
---

# Upstream Merge Guide

> The verified playbook for syncing upstream `diegosouzapw/OmniRoute` release branches
> into this fork's `patty` branch. Written from the 2026-09-24 v3.8.51 sync
> (merge-base `a179ffed5` → tip `6b8c5df66f`: **336 conflicted paths, 16,767 files
> changed, 1,668 upstream commits**) — every rule below was learned the hard way.
>
> Companion: [`UPSTREAM_MERGE_GOTCHAS.md`](./UPSTREAM_MERGE_GOTCHAS.md) — the trap
> catalog with receipts. `FORK_NOTES.md` (repo root) holds the per-merge decision
> log; this guide holds the _process_.

---

## 0. What a sync involves

```text
upstream release/vX.Y.Z ──┐
                          ├─→ merge into patty ──→ PR ──→ GHCR image build ──→ VPS cutover
patty (fork features) ────┘
```

Plan for the sync to take a full session. Roughly:

| Phase                                | Share of the work |
| ------------------------------------ | ----------------- |
| Conflict resolution (mechanical)     | ~30%              |
| **Verification + regression triage** | ~60%              |
| Commit / PR / image build / deploy   | ~10%              |

The verification share is not negotiable: this fork diverges in load-bearing places
(patty settlement, HIDE_UPSTREAM_METADATA, compression engines, web-tool parsing),
and upstream refactors aggressively (v3.8.51 extracted all of `chatCore.ts`'s
pipeline into modules). Silent breakage is the default outcome of a rushed merge.

---

## 1. Preflight

### 1.1 Confirm the target and base state

- Fork integration branch is **`patty`** (successor of the retired `custom-features`).
- Check upstream's base-green state before cutting anything — upstream's own tip
  can be red (issue `diegosouzapw/OmniRoute#14547` during the v3.8.51 sync). Red
  upstream tip ⇒ expect inherited failures; **do not plan to fix them in the sync
  branch** (base-red fixes are their own freeze-gated PR upstream).
- Record the numbers up front — you will need them for the failure attribution:

```bash
git merge-base HEAD <upstream-tip>          # the divergence point
git rev-list --count <base>..patty           # fork-side commits
git rev-list --count <base>..<upstream-tip>  # upstream-side commits
```

### 1.2 Isolated worktree — never the shared main checkout

The main checkout is shared by parallel sessions; a `git checkout` there can destroy
someone's in-flight work. Every sync gets its own worktree:

```bash
BRANCH="sync/upstream-vX.Y.Z-$(date +%Y%m%d)"
git worktree add "/Volumes/nvme_2tb/projects/omniroute-sync-vX.Y.Z" -b "$BRANCH" origin/patty
cd "/Volumes/nvme_2tb/projects/omniroute-sync-vX.Y.Z"
# Reuse the main checkout's node_modules — HARD-FILE CLONE, never a symlink:
cp -Rc "$(git -C /Volumes/nvme_2tb/projects/OmniRoute rev-parse --show-toplevel)/node_modules" node_modules
```

- `cp -Rc` (APFS clonefile): ~seconds, near-zero disk, and unlike a symlink it does
  not break the dev server / Turbopack (a symlinked `node_modules` resolves outside
  the project root and FATALs the build).
- This fork deliberately places sync worktrees on the external drive
  (`.claude/worktrees/` is the convention for _development_ tasks; syncs are bigger
  than the main disk's free space — the checkout + node_modules is ~30 GB).
- **Serialize git mutations in the worktree.** Two concurrent `git add` runs hit an
  index lock collision once during v3.8.51. One git command at a time.

### 1.3 Merge strategy: merge, not rebase

`patty` is a pushed, shared branch — history rewrites are off the table. Use:

```bash
git merge --no-ff <upstream-tip>
```

Git has no per-commit "keep our patch" setting. `-X ours` only favors our side
for conflicting hunks; upstream edits that merge cleanly still enter the tree.
`-s ours` drops the upstream tree entirely. Path-level merge drivers also cannot
express this feature-level invariant across `chatCore.ts`, config, persistence,
and UI. Treat `FORK_NOTES.md` and the checklist below as the retention policy.

---

## 2. The conflict rulebook (R1–R7)

Established during the v3.8.38 and v3.8.51 syncs. Apply in order; **R7 overrides
everything** — when a conflict is genuinely ambiguous, stop and ask the operator.

| #   | Rule                                                       | Scope / notes                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `.github/workflows/*` stay **deleted**                     | The fork runs no upstream CI. Applies to delete-modify conflicts AND to files upstream _newly adds_ under `.github/workflows/` (v3.8.51 re-added `api-route-typecheck.yml` + `release-acceptance.yml` silently — delete them again). Exception: the fork's OWN deploy pipeline `build-patty-image.yml` (see §7). |
| R2  | Upstream **deletions win**                                 | When upstream deleted a file the fork modified (provider retirements: qwen-web, GPL providers, …), accept the deletion. Dead fork-side services that only served the deleted feature go too — but verify zero live references first (`grep -rln` the service name outside itself).                               |
| R3  | Docs / i18n prose: **theirs**, then re-apply Patty rebrand | Any doc upstream touched → take upstream's text, then re-substitute branding (Patty name, versioned icon URLs). Locale grammar fixes stay upstream's.                                                                                                                                                            |
| R4  | Locale JSON: **deep-union**                                | `src/i18n/messages/*.json` — union of base + ours + theirs per key. Never take one side wholesale: ours carries fork keys (`sidebar.compressionPonytail`), theirs carries new upstream keys. Script it (a ~30-line Node deep-union); verify the merged `en.json` contains one key from each side.                |
| R5  | Quality baselines: **theirs**                              | `quality-baseline.json`, eslint suppressions, ratchet configs track upstream's reality. The fork's own entries survive (they're additive).                                                                                                                                                                       |
| R6  | `package.json`: **union**                                  | Take upstream's dependency changes, re-add fork-only deps (`pretendard`). Regenerate the lock with `npm install --package-lock-only`, then a real `npm install` before running anything.                                                                                                                         |
| R7  | **Ask when confusing**                                     | Custom-vs-upstream is not always decidable from the diff. v3.8.51 example: fork's 4,085-line `chatgpt-web.ts` executor vs upstream's 51-line clean-room rewrite — an operator call ("take theirs for now"), not a heuristic one.                                                                                 |

### Fork features that must survive every sync

Checklist to re-verify at the end (all bit me or nearly did):

- Patty settlement + `publicModel` echo (`open-sse/services/pattyGateway.ts`, the
  grafted blocks in `chatCore.ts` non-streaming tail + `streamingPipeline.ts`,
  `src/app/api/internal/codex-responses-ws/route.ts`)
- `HIDE_UPSTREAM_METADATA` flag (featureFlags, combo terminal messages via
  `summarizeComboErrors` in `open-sse/services/combo/comboErrorAggregation.ts`,
  malformed-502 message, `/v1/models` catalog strip, its row in
  `docs/reference/FEATURE_FLAGS.md` — the count assertion in
  `tests/unit/feature-flags-doc-sync-static.test.ts` fails if the row drifts)
- Pretendard / Patty branding (`src/app/login/PattyShell.tsx`, self-hosted font in
  globals.css, `public/sw.js` constants, `public/icon-*.png?v=patty-*`)
- Compression: incremental cache, ponytail engine, KO language pack,
  `autoTriggerPlan`'s enginesExplicit guard; stable saturated-conversation
  cache checkpoints and byte-stable `purify_history` notices; the independent
  `reactiveContextCompactionEnabled` gate (SRC-014 in `FORK_NOTES.md`). Verify
  both automatic `compressContext()` paths honor the flag while Session Dedup
  and Ponytail can still run when the flag is false. The production DB value is
  `false`; source defaults to `true` for existing installations.
- `getRuntimePorts()` (no hardcoded port literals), `staleEncryptionGuard`
- The `_tasks/` directory is a separate git repo — never track it in the main repo

---

## 3. Resolving conflicts — patterns that repeat

### 3.1 Import hunks: union, then prune unused

Import-region conflicts are ~⅓ of the hunks. Union both sides' lines, dedupe,
**then** let eslint tell you which imports are now unused and prune them —
do not hand-guess.

**The trap:** hunks that start _mid-import-statement_. The common `import {` opener
belongs to one side; the other side's continuation lines get spliced without it,
producing syntactically broken "orphan" fragments (v3.8.51: `chatHelpers.ts`,
`chatCore.ts` twice, one test file). Symptom: `esbuild`/`prettier` parse errors at
lines that look fine. See GOTCHAS §1.

**The second trap:** dedupe per-hunk, not per-file. The same symbol can survive in
two _different_ hunks importing from the same module. tsc merges duplicate named
imports silently; **Turbopack rejects them** ("the name X is defined multiple
times") — 18 such errors shipped past typecheck and eslint in v3.8.51 and only the
image build caught them. After resolving a file's import region, run a duplicate
import scan (GOTCHAS §2 has the script pattern).

### 3.2 Logic hunks: prefer upstream's structure, graft fork's deltas

Upstream refactors whole regions into modules (v3.8.51: `providerExecutionPipeline`,
`nonStreamingProviderLeg`, `upstreamBody`, `combo/*`, `chatAdmissionRelease`).
When the fork's inline copy of a behavior conflicts with upstream's extracted
module:

1. Take **upstream's structure**.
2. Check whether the extracted module actually contains the fork's delta —
   `git grep` the symbol in upstream's tree at their tip.
3. If the delta is missing, re-apply it _in the module_ (small graft), not by
   keeping the fork's whole inline block. Keeping both = double application —
   that is how v3.8.51 leaked a replaced model's effort suffix (the stale
   `normalizeThinkingForModel`/`applyDefaultReasoningEffort` inline blocks
   double-applied on top of `chatCore/upstreamBody.ts`).

### 3.3 When a whole file is fork-diverged, decide the file, not the hunks

For fork-flagship files (`duckduckgo-web.ts`, `gitlab.ts`, `strategySelector.ts`,
`public/sw.js`): diff `HEAD` vs upstream-tip for that file first. Often the right
move is "fork file + graft upstream's specific improvement" (gitlab's #12958 403
fallback) or "upstream file + fork's constants" (sw.js: upstream's #11779 logic +
fork's CACHE_NAME/icons/push handler). Resolve at the file level, then verify with
that file's tests — both sides' tests exist in the tree after the merge, and they
pin **different, sometimes contradictory** semantics (GOTCHAS §5).

### 3.4 If you corrupt a file, rebuild it from the index stages

The merge keeps three stage blobs until you `git add` the path:

```bash
git show :1:<path>   # merge-base version
git show :2:<path>   # ours (patty)
git show :3:<path>   # theirs (upstream tip)
git checkout -m -- <path>   # recreate the conflicted file from stages
```

`git checkout -m` is the recovery move after a bad resolution — hunk _grouping_
may differ slightly from the original merge output, but the three versions are
exact. **Never `git stash`** in this repo (shared object store; cross-session
incidents on record).

### 3.5 Record every non-obvious decision

Write them into `FORK_NOTES.md` under a `## vX.Y.Z sync record` section as you go:
what was taken from whom, which fork features were re-grafted where, which
follow-ups were deliberately deferred. Future-you greps FORK_NOTES first.

---

## 4. Post-resolution hygiene (run all of these, in order)

```bash
# 1. No conflict markers anywhere
grep -rn "^<<<<<<< \|^>>>>>>> " --include="*.ts" --include="*.tsx" --include="*.json" \
  --include="*.md" --include="*.css" --include="*.mjs" src/ open-sse/ docs/ tests/ package.json

# 2. Whole-tree PARSE sweep (esbuild transformSync over git ls-files).
#    Catches broken imports/duplicate declarations that tsc's include list misses —
#    typecheck:core does NOT cover tests/ or scripts/. Cover: src, open-sse,
#    electron, bin, tests, scripts.

# 3. Type gates
npm run typecheck:core
npm run typecheck:noimplicit:core   # compare error COUNT against patty's pre-merge count

# 4. Lint with the project's suppressions
npm run lint    # 0 errors expected; a fixed violation count may require --prune-suppressions

# 5. Fork invariants (see §2 checklist)
```

---

## 5. Verification — the part that actually takes the time

### 5.1 Establish the patty baseline BEFORE judging the merged tree

Run the full unit suite on **patty's pre-merge HEAD** first and save the failing
test list. The fork carries pre-existing reds (~150 failures / 34,649 tests at
v3.8.51). Without the baseline you cannot tell regression from inheritance.

```bash
npm run test:unit   # in the MAIN checkout (still on pre-merge patty), log to a file
grep "^test at " <log> | sed 's/^test at //; s/:[0-9]*:[0-9]*$//' | sort -u > fail-patty.txt
```

### 5.2 Run the merged suite with the project's exact flags

`npm run test:unit` (it passes `--test-force-exit`, `--test-concurrency=4`, and the
polyfill/data-dir setup imports). **Never** re-batch many test files into one bare
`node --test` invocation — without `--test-force-exit` the runner hangs forever on
the first file that leaves a DB handle open, and it _looks_ like your merge broke
something (GOTCHAS §7).

### 5.3 The decisive classifier: pure-upstream worktree

This is the single most valuable technique from v3.8.51. For every failing test
that is NOT in patty's baseline:

```bash
git worktree add --detach /Volumes/nvme_2tb/upstream-check <upstream-tip>
cp -Rc <sync-worktree>/node_modules /Volumes/nvme_2tb/upstream-check/node_modules
# run the failing test FILES there, with the same flags
```

Every failure sorts into exactly one bucket:

| Bucket                     | Signature                                                                                                   | Action                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream base-red**      | Fails identically on the pure upstream tip                                                                  | Inherit. List in the PR under `⚠️ base-red inherited`. Never fix in the sync branch.                                                    |
| **Fork-by-design**         | Asserts something the fork deliberately diverges from (workflow files! branding! strict-vs-lenient parsing) | Either align the fork (preferred when upstream's semantics are a real improvement) or update the fork's test — and record the decision. |
| **Pre-existing patty red** | In the pre-merge baseline                                                                                   | Inherit.                                                                                                                                |
| **Merge regression**       | Green on both patty and upstream, red on the merge                                                          | **Fix now.** Usually a stale inline block, a wrong side taken, or an import splice.                                                     |

### 5.4 Gates that lie, and the one that doesn't

- `typecheck:core` misses: duplicate named imports (tsc merges them), everything in
  `tests/` + `scripts/` (include list), and runtime import cycles.
- eslint misses what tsc merges.
- **`npm run build` (Turbopack) is the honest gate** — it caught 18 errors all the
  others waved through. Run a full local build before pushing anything that will
  trigger the image pipeline. Budget ~7 min on a 10-core Mac.

---

## 6. Migration-number collisions

The fork and upstream number migrations independently; a sync that lands where the
ranges overlap (v3.8.51: fork's `164_patty_settlement_outbox` vs upstream's
`164_retire_microsoft_designer_web`) hits the runner's collision guard and every
DB-touching test dies with `Migration version collision detected`.

The fix is mechanical — upstream built the machinery for exactly this:

1. `git mv src/lib/db/migrations/<old>_<name>.sql src/lib/db/migrations/<next-free>_<name>.sql`
2. Add a retroactive guard — `isSchemaAlreadyApplied` case in
   `src/lib/db/migrationRunner.ts` keyed on the NEW number, checking for the
   schema artifact (so a DB that applied the old number doesn't replay).
3. Register the ledger rehome in `RENAMED_MIGRATION_COMPATIBILITY`
   (`src/lib/db/migrationRunner/constants.ts`) — the runner rewrites the ledger row
   `old → new` and frees the old slot for upstream's migration.
4. **Tests pin the registry**: `tests/unit/db-migrationrunner-constants-split.test.ts`
   asserts the entry COUNT and pins the last entries positionally (`.at(-7)`…).
   Insert your entry _before_ the pinned tail, and bump the count assertion.

The SQL must be idempotent (`IF NOT EXISTS`) — a DB that applied the old number
will replay the new one through the guard's tolerance path.

---

## 7. Shipping: PR → image → deploy

### 7.1 Commit and PR

- Conventional commit; hooks enforce no-AI-attribution and will also **fail on
  stale eslint suppressions** — if the merge deleted violating files, run the
  pruned eslint once (`npx eslint . --suppressions-location config/quality/eslint-suppressions.json --prune-suppressions`) and commit the shrunken file.
- PR body: gates table, **failure attribution** (the four buckets with counts),
  `⚠️ base-red inherited: <issue>` note, follow-ups.
- Merge the PR (`--merge`). `patty` is the only branch that matters; delete the
  sync branch.

### 7.2 The image pipeline (production = `omni.patty.io`)

Production runs `ghcr.io/patrickrho-patty/omniroute:latest` (container `omniroute-p5`,
compose at `/opt/omniroute/docker-compose.yml` on the Contabo VPS
`109.123.231.227`). The image is built by **`.github/workflows/build-patty-image.yml`
— the ONE workflow the fork keeps** (restored 2026-09-24 after the 2026-08-30
sweep deleted it and GHCR silently went stale for a month).

**Repo-owner transfers break this pipeline in three places — check all three.**
The fork has already moved twice (`patrickrho-patty` → `patty-internal` 2026-08 →
back to `patrickrho-patty` 2026-10), and each move silently skipped every build
because the job guard was an equality check on the old slug. Since 2026-10 the
workflow derives `IMAGE_NAME` from `github.repository_owner`, guards negatively
(`github.repository != 'diegosouzapw/OmniRoute'`) and `scripts/deploy-ghcr.sh`
derives the owner from the `origin` remote, so neither needs editing on a
transfer. The two that still do:

1. `/opt/omniroute/docker-compose.yml` on the VPS — its `image:` line names the
   old namespace, so the pull silently keeps the previous container.
2. The VPS's `docker login ghcr.io` credential — it was issued for the old
   namespace and may lose `read:packages` on the new one.

Verify a transfer end-to-end by the **image digest**, never by container health:
`docker inspect --format '{{index .RepoDigests 0}}' omniroute-p5` must change.

Since v3.8.51 the workflow builds Next **on the runner host** and substitutes the
Dockerfile's builder stage via a named build context (`build-contexts:
builder=ci-builder`) — the in-Docker build OOMs the 16 GB runner. Do not "simplify"
this back to a plain `docker build` without reading
[`UPSTREAM_MERGE_GOTCHAS.md`](./UPSTREAM_MERGE_GOTCHAS.md) §9 first.

### 7.3 Cutover

```bash
./scripts/deploy-ghcr.sh --vps-only   # pulls :latest, force-recreates, polls health
curl -s https://omni.patty.io/api/monitoring/health   # expect {"status":"healthy",...}
```

`scripts/deploy-vps.sh` and [`DEPLOY_FORK_VPS.md`](./DEPLOY_FORK_VPS.md) describe
the RETIRED build-on-VPS/systemd/jebo.ai flow — do not use them for production
deploys (teardown of `/opt/OmniRoute` + a doc rewrite is a tracked follow-up).

---

## 8. Condensed checklist

```text
PREFLIGHT    base-green? · worktree on external drive · cp -Rc node_modules · baseline suite run
MERGE        git merge --no-ff · R1–R7 · import-union + prune · file-level calls on flagships
HYGIENE      marker sweep · esbuild parse sweep · typecheck ×2 · lint · fork invariants
VERIFY       full suite · diff vs baseline · pure-upstream classifier on every new failure
             · local npm run build (the honest gate)
COLLISIONS   migration renumber + RENAMED_MIGRATION_COMPATIBILITY + pinned-test count
SHIP         FORK_NOTES sync record · PR with attribution · merge · watch GHCR build
DEPLOY       deploy-ghcr.sh --vps-only · omni.patty.io health · record follow-ups
CLEANUP      worktree remove (both sync + upstream-check) · main checkout ff to patty
```
