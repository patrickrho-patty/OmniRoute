---
title: "Upstream Merge Gotchas"
version: 3.8.51
lastUpdated: 2026-09-25
---

# Upstream Merge Gotchas — the trap catalog

> Every entry below fired during a real sync (mostly v3.8.51, 2026-09-24; a few from
> v3.8.38/v3.8.40). Format: **symptom → cause → detection → fix**. Read this before
> deviating from [`UPSTREAM_MERGE_GUIDE.md`](./UPSTREAM_MERGE_GUIDE.md).

---

## 1. Mid-import-statement hunks splice into broken syntax

**Symptom.** `prettier` (via pre-commit) or `esbuild` throws a parse error at a line
that looks perfectly fine — `SyntaxError: ',' expected` in a test file, `Unexpected
"}"` at an import region.

**Cause.** Conflict hunks do not respect statement boundaries. The common
`import {` opener belongs to one side; the other side's continuation lines
(`  foo,` … `} from "…"`) get unioned in _without_ their opener. Classic shapes:

```text
import { shouldPreserveCacheControl } from "../utils/cacheControlPolicy.ts";   ← ours one-liner
import {
  logClientRawRequestRedacted,
} from "@/lib/guardrails/videoBridgeSnapshotRedaction";
  shouldPreserveCacheControl,          ← ORPHAN: theirs' multi-line, opener lost
  resolveConnectionCacheOverride,
} from "../utils/cacheControlPolicy.ts";
```

Same module imported twice with different line shapes is the smell: one side had a
one-liner, the other a multi-line statement for the SAME module.

**Detection.** The esbuild parse sweep (guide §4). `tsc` may not see it if the file
is outside the include list; prettier only runs at commit time — far too late.

**Fix.** Merge the two statements into the multi-line superset; dedupe the names.

---

## 2. Duplicate named imports: tsc merges, Turbopack rejects

**Symptom.** CI image build fails with 18× `Error: the name 'X' is defined
multiple times` in one file — after typecheck:core, eslint, AND 42k unit tests all
passed locally.

**Cause.** Line-level import union deduped _per hunk_; the same symbol survived in
two different hunks importing from the same module. TypeScript silently merges
duplicate named imports from the same module; **Turbopack's bundler errors**.

**Detection.** Scan for it explicitly after resolving any import-heavy file:

```js
// per file: collect named bindings from every `import {…} from "mod"` statement;
// a binding imported twice from the SAME module (across statements) is a dupe.
```

And the ultimate detector: a full local `npm run build` before pushing. ~7 minutes
that saves a 20-minute CI round trip — every time.

**Fix.** Keep the first statement, strip the duplicate names from later ones, drop
emptied statements.

---

## 3. Regex conflict-resolvers are booby-trapped (re.S spans hunks)

**Symptom.** A scripted resolver (Python `re` with `re.S`) "unioned" hunks it was
never meant to touch; adjacent hunks got fused; when one side of a hunk is EMPTY
(`=======\n>>>>>>>`), the non-greedy group grows across the hunk boundary and
swallows the next hunk whole. Corrupted `providerLimits.ts`, `searchProxy.ts`,
`globals.css` in v3.8.40-era work.

**Fix.** Never regex over conflict markers. Parse **line-by-line**: split on exact
`<<<<<<< `/`=======`/`>>>>>>> ` lines, collect `ours`/`theirs` line arrays per
hunk, render resolutions from arrays. A ~40-line parser (`/tmp/hunkLib.mjs` pattern
from v3.8.51) is sufficient and cannot span hunks.

---

## 4. `git checkout -m` regroups hunks — re-triage after rebuild

**Symptom.** After rebuilding a conflicted file from the index stages
(`git checkout -m -- <path>`), the hunk count differs from the original merge
(v3.8.51: 41 → 47) and hunk sizes change (a 17-line side becomes 450).

**Cause.** The original merge (ort) and the file-level three-way re-merge align
context slightly differently.

**Fix.** Expected behavior — re-run the hunk inventory after any `-m` rebuild and
re-index your decisions. The three stage blobs are exact; only the _presentation_
differs. And remember: stages exist only until `git add` — keep notes outside the
index if you need them.

---

## 5. Both sides' tests survive the merge — and they contradict each other

**Symptom.** Fixing one test breaks another; both name the same feature.

Real v3.8.51 cases:

- Fork's `strategy-selector-engine-toggle.test.ts` expected explicitly-enabled
  lossy engines (rtk/llmlingua) to survive plan resolution; upstream's
  `active-combo-dispatch.test.ts` expected them downgraded. Upstream's model:
  **engine toggles declare capability; the `allow-lossy` request header declares
  intent.** Resolution: adopt upstream's semantics, update the fork test's
  secondary assertion.
- Fork's `web-tools-translation-2820.test.ts` pinned the STRICT decoder
  ("fuzzy/undeclared names are never inferred"); upstream's `maxai.test.ts`
  pinned the LENIENT parser (emitted-name fallback). Resolution: two layers —
  lenient canonical parser (`buildToolAwareResult`) for tag-contract executors,
  strict decoder only for chatgpt-web's fenced-JSON envelope.
- Fork's sw.js tests pinned CACHE_NAME + versioned icons; upstream's
  service-worker tests pinned #11779 navigation logic. Resolution: upstream logic
  - fork constants + fork push handler — both files' tests green.

**Rule.** When tests from both sides conflict, look for the _two-layer_ resolution
before picking a winner. Then record it in FORK_NOTES — the contradiction WILL
come back on the next sync.

---

## 6. Fork-added lines survive in "common" regions — dropping the declaration breaks them

**Symptom.** `TS2304: Cannot find name 'X'` at lines that were never conflicted.

**Cause.** Three-way merge keeps fork-added lines wherever upstream didn't touch
the neighborhood — they land in "common" regions. Meanwhile the _declaration_
lived in a region upstream DID touch, and your resolution dropped it
(v3.8.51: `bypassChatGptWebSharedPromptTransforms` — declaration in a conflicted
hunk resolved to theirs, three usages survived in common regions).

**Fix.** Two valid directions: (a) restore the fork declaration, or (b) remove the
surviving usages too and adopt upstream's semantics. Decide by intent, not by
locality — then grep the symbol tree-wide to catch every survivor.

---

## 7. Batching test files into one `node --test` process hangs

**Symptom.** Re-running a batch of ~250 failing test files in one invocation
freezes mid-run; the log's last line is a passing test; killing it shows nothing
wrong.

**Cause.** Some test files leave DB/event-loop handles open. `npm run test:unit`
passes `--test-force-exit` (plus `--test-concurrency=4` and the polyfill/data-dir
setup imports). A bare batched invocation has none of that and parks forever on
the first leaked handle.

**Fix.** Always replicate the npm script's flags:

```bash
node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
     --import ./tests/_setup/isolateDataDir.ts \
     --test --test-force-exit --test-concurrency=4 <files>
```

A "hang" in a properly-flagged run is a real leak worth investigating; a hang in
an unflagged batch is an artifact. Don't burn an hour on the second kind (cost:
one hour, v3.8.51).

---

## 8. Upstream tests read repo state the fork diverges from

**Symptom.** Upstream-authored tests fail on the merged tree while passing on
upstream's tip. They are not regressions — they assert a repo state the fork
deliberately doesn't have.

Cases: workflow-file tests (fork deletes `.github/workflows` — ~9 files fail by
design, growing each sync); `chatgpt-web-source-retirement.test.ts` (upstream's
tripwire asserting fork service files are ABSENT — the fork's "dormant services"
concept loses to it: delete them, git history is the resurrection path);
`service-worker-navigation-fallback` (upstream sw.js logic vs fork's older file —
graft, don't choose).

**Fix.** Classify with the pure-upstream worktree (guide §5.3) — "green upstream /
red merged" + the diff tells you whether it's this bucket or a real regression.

---

## 9. The GHCR image build: three ways to lose an afternoon

The image pipeline (`.github/workflows/build-patty-image.yml`) is the fork's ONE
workflow — if it's missing (deleted by a sweep, drift, or an over-eager R1
application), **nothing builds and GHCR silently serves a stale `:latest`**. That
state survived a full month (Aug 29 → Sep 24) before anyone noticed. Check
`gh run list --workflow build-patty-image.yml` as part of deploy preflight.

### 9.1 In-Docker `next build` OOMs the 16 GB runner (deterministic since v3.8.51)

`ResourceExhausted: … cannot allocate memory` from buildkit, or the job dying
silently ("The operation was canceled") ~9 min into compile. The app outgrew the
runner budget: 2 V8 processes + Turbopack's native RSS + buildkit's own tax.
The workflow's old `OMNIROUTE_BUILD_MEMORY_MB=8192` override made it worse
(8 GB ceiling PER V8 process on a 16 GB box).

**Current shape (do not regress it):** build Next on the runner host
(`NODE_OPTIONS=--max-old-space-size=6144`, `CIRCLE_NODE_TOTAL=2`, 8 GB swapfile,
`OMNIROUTE_MITM_STUB=1`), verify the standalone bundle with the same `node -e`
check the Dockerfile used (ABSOLUTE paths — `createRequire` rejects relative),
assemble a `ci-builder/` tree mirroring the builder stage's outputs
(`.build/next/standalone`, `node_modules/{better-sqlite3,playwright,playwright-core}`,
`scripts/dev/healthcheck.mjs`), and hand it to `docker/build-push-action` with
`build-contexts: builder=ci-builder`. The Dockerfile stays untouched.

### 9.2 The gyp-built better-sqlite3 native lands in the STANDALONE tree

`npm run build` compiles `better_sqlite3.node` into
`.build/next/standalone/node_modules/better-sqlite3/build/Release/`; the host
`node_modules/` copy only gets `prebuilds/` (no `build/Release`). The Dockerfile's
runner-base stage copies BOTH paths from the builder and asserts
`test -f build/Release/better_sqlite3.node` on the node_modules copy. Mirror the
built native across in the assembly step (fallback: copy `prebuilds/linux-x64.node`
to that path) or the image build dies at the assertion.

### 9.3 Duplicate-import errors only surface HERE

See §2 — the image build is the only Turbopack gate in the chain. A red build
with "defined multiple times" is an import-resolution bug, not a Docker problem.

---

## 10. Smaller bites, still venomous

- **Pre-commit fails on stale eslint suppressions** after the merge deletes
  violating files: run the same lint with `--prune-suppressions`, commit the
  shrunken JSON (v3.8.51 pruned 1,936 stale lines).
- **`--prune-suppressions` run exits non-zero** even on success — check the file
  diff, not the exit code.
- **Migration registry tests pin positionally** (`.at(-7)`…) — insert new
  `RENAMED_MIGRATION_COMPATIBILITY` entries BEFORE the pinned tail.
- **i18n key-completeness fails on both sides** (upstream adds unlocalized en
  keys; fork locales carry legacy extras). Pre-existing on both tips ⇒ inherit,
  don't chase parity in the sync.
- **Tests auto-take "theirs" when the fork never touched them** — then fork-flavored
  _neighbors_ break against theirs' modules (v3.8.51: `chat-body-admission`).
  The test file's provenance (`git ls-tree HEAD <file>`) tells you whose contract
  it pins.
- **One test file can be green in isolation, red in a batch** (DB contention /
  temp-dir races) — reproduce solo before diagnosing (`--test-name-pattern`).
- **`deploy-vps.sh` / `DEPLOY_FORK_VPS.md` describe the dead flow** (jebo.ai,
  systemd `omniroute.service`, build-on-VPS, port 12160). Production is
  `deploy-ghcr.sh` → `omniroute-p5` container → `omni.patty.io` (Cloudflare →
  caddy → 10.200.85.232:20128). Nothing listens on 12160 anymore.
- **Don't `git stash`. Ever.** In this repo it operates on the shared object
  store and has eaten another session's work twice (on record). Use the index
  stages / `git show <ref>:<path>` for comparisons.

## 11. `package.json` is a UNION — and a dirty `node_modules` hides the loss

Taking upstream's `package.json` wholesale (then re-adding the one dependency you
happen to remember) drops every fork-only dependency in one silent step. v3.8.52
lost `magic-grid@^3.4.7`, declared only for the fork's unified MagicGrid quota
board (`QuotaCardGrid.tsx`).

**The local build will not catch it.** A sync worktree's `node_modules` is
hard-linked from the main checkout, which was installed _before_ the merge — so
`npm run build` still resolves the dropped package off disk and goes green. The
first thing that fails is the GHCR workflow's clean `npm ci`, ~20 minutes in, at
the Turbopack step. Cost of this lesson: one wasted CI run.

Before merging, diff the manifests key-by-key:

```bash
git show <fork-tip>:package.json   > /tmp/fork.json
git show <merged>:package.json     > /tmp/merged.json
# compare dependencies / devDependencies / optionalDependencies / overrides /
# engines / scripts. Upstream's version BUMPS are expected; fork-only KEYS are not.
```

Then close the loop against the lockfile: every bare import in `src/`,
`open-sse/`, `bin/` and `electron/` must exist as a package in
`package-lock.json`. (v3.8.52: 3,570 files scanned, four findings, all false
positives — `bun:sqlite`, the package's own `omniroute/plugins/sdk`
self-reference, and two dynamic template imports.) `npm ci --dry-run` proves the
lockfile and the manifest are in sync, which is the check the runner performs.
