// scripts/ad-hoc/probe-hide-upstream-db-override.ts
//
// Reproduces the PROD configuration exactly: HIDE_UPSTREAM_METADATA stored as a DB
// override in `key_value` (namespace "feature_flags"), NOT as process.env. The existing
// integration test only covers the env path.
//
// IMPORTANT: every db/featureFlags import MUST be dynamic and happen AFTER the harness
// has set DATA_DIR — a static import resolves the real ~/.omniroute database instead
// (learned the hard way; see cleanup-probe-side-effects.ts).

import { createComboRoutingHarness } from "../../tests/integration/_comboRoutingHarness.ts";

const h = await createComboRoutingHarness("probe-hide-upstream-db");
const {
  BaseExecutor,
  combosDb,
  handleChat,
  buildRequest,
  seedConnection,
  settingsDb,
  resetStorage,
} = h;

const COMBO = "probe-combo-echo";
const UPSTREAM = "openai/gpt-4o-mini";

async function main() {
  const { setFeatureFlagOverride } = await import("../../src/lib/db/featureFlags.ts");
  const { isHideUpstreamMetadataEnabled } = await import("../../src/shared/utils/featureFlags.ts");

  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  delete process.env.HIDE_UPSTREAM_METADATA;
  await resetStorage();

  await seedConnection("openai", { apiKey: "sk-probe" });
  await combosDb.createCombo({
    name: COMBO,
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [UPSTREAM],
  });

  // The prod state: DB override only, no env var.
  setFeatureFlagOverride("HIDE_UPSTREAM_METADATA", "true");
  console.log("env HIDE_UPSTREAM_METADATA     :", process.env.HIDE_UPSTREAM_METADATA ?? "(unset)");
  console.log("isHideUpstreamMetadataEnabled :", isHideUpstreamMetadataEnabled());
  console.log(
    "settings.echoRequestedModelName:",
    (await settingsDb.getSettings()).echoRequestedModelName ?? "(unset)"
  );

  h.installRecordingFetch();

  for (const stream of [false, true]) {
    const res = await handleChat(
      buildRequest({
        body: { model: COMBO, stream, messages: [{ role: "user", content: "ping" }] },
      })
    );
    const text = await res.text();
    const dispatched = h.calls.at(-1)?.model;
    const seen = stream
      ? (text.match(/"model":"([^"]+)"/) ?? [])[1]
      : (JSON.parse(text) as { model?: string }).model;
    console.log(
      `stream=${String(stream).padEnd(5)} dispatched=${String(dispatched).padEnd(14)} response.model=${String(
        seen
      ).padEnd(18)} ${seen === COMBO ? "OK echo" : "LEAK / no echo"}`
    );
    console.log(
      `   x-omniroute-model=${res.headers.get("x-omniroute-model")} x-omniroute-provider=${res.headers.get(
        "x-omniroute-provider"
      )}`
    );
  }
}

try {
  await main();
} finally {
  await h.cleanup();
}
