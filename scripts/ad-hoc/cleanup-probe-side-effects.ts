// scripts/ad-hoc/cleanup-probe-side-effects.ts
// One-shot cleanup: the first run of probe-hide-upstream-db-override.ts resolved the
// DEFAULT data dir (~/.omniroute) instead of the harness temp dir, so it wrote one combo
// and one feature-flag override into the operator's local dev database. Remove exactly
// those two artifacts (identified by the created_at of that run).

import { deleteCombo } from "../../src/lib/db/combos.ts";
import { removeFeatureFlagOverride } from "../../src/lib/db/featureFlags.ts";

const COMBO_ID = "ae660d44-71a9-4321-8a26-507df48e3f25"; // created 2026-11-25T05:14:14Z by the probe

const removedCombo = await deleteCombo(COMBO_ID);
removeFeatureFlagOverride("HIDE_UPSTREAM_METADATA");

console.log("combo deleted:", removedCombo, "(id", COMBO_ID + ")");
console.log("HIDE_UPSTREAM_METADATA override removed");
