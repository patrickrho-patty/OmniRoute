import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UUID_DEPENDENCY_IDS,
  buildBridgeModuleSource,
} from "../../open-sse/utils/chatgptWebFirstParty.ts";

import type { ChatGptWebFirstPartyModuleContract } from "../../open-sse/utils/chatgptWebFirstParty.ts";

/**
 * The clean-room bridge instantiates chatgpt.com's own integrity module inside the page with a
 * fake webpack `require`. That module needs one helper — a fresh UUID — whose webpack id is part
 * of the page build, not of our contract. chatgpt.com renamed it (TI → DD), which broke every
 * ChatGPT Web request with `Unsupported ChatGPT integrity dependency: DD`.
 *
 * The generated bridge source is loaded as a real module (data: URL) against a stubbed page
 * module, so the shim is executed rather than string-matched. No eval/new Function: the repo
 * bans those outright.
 */

const ASSET_URL = "https://chatgpt.com/cdn/assets/app-abc123.js";
const BRIDGE_KEY = "__omnirouteChatGptFirstPartyV1";

const CONTRACT: ChatGptWebFirstPartyModuleContract = {
  finalizeRequirements: "finalizeRequirements",
  proofManager: "proofManager",
  turnstileManager: "turnstileManager",
  requestClient: "requestClient",
  buildSentinelHeaders: "buildSentinelHeaders",
  resolveIntegrity: "resolveIntegrity",
  resolveIntegrityModule: "MODULE_ID",
};

type BridgeGlobals = {
  window?: unknown;
  upstream?: unknown;
  fetch?: unknown;
};

/** Counter so each run evaluates as a distinct ES module (identical data: URLs are cached). */
let runCounter = 0;

/** Run the generated bridge source against a stubbed first-party module. */
async function runBridge(contract: ChatGptWebFirstPartyModuleContract, moduleIds: string[]) {
  const source = `${buildBridgeModuleSource(ASSET_URL, contract).replace(
    /^import \* as upstream from .*?;/,
    ""
  )}\n// run-${++runCounter}`;

  const windowStub: Record<string, unknown> = {};
  const upstreamStub = {
    __webpack_modules__: {
      [contract.resolveIntegrityModule as string]: (
        _module: unknown,
        exports: Record<string, unknown>,
        require: (id: string) => Record<string, unknown>
      ) => {
        // Mirror what the real integrity module does: pull a UUID per required helper.
        const produced = moduleIds.map((id) => {
          const helper = require(id) as { a?: () => string };
          assert.equal(typeof helper?.a, "function", `module ${id} must expose a()`);
          return helper.a?.();
        });
        exports[contract.resolveIntegrity as string] = () => produced.join(":");
      },
    },
  };

  const globals = globalThis as unknown as BridgeGlobals & typeof globalThis;
  const previous: BridgeGlobals = {
    window: globals.window,
    upstream: (globals as unknown as { upstream?: unknown }).upstream,
    fetch: globals.fetch,
  };
  globals.window = windowStub;
  (globals as unknown as { upstream?: unknown }).upstream = upstreamStub;
  globals.fetch = async () => ({ ok: true, json: async () => ({ accessToken: "token" }) });

  try {
    const encoded = Buffer.from(source, "utf8").toString("base64");
    await import(`data:text/javascript;base64,${encoded}`);
  } finally {
    globals.window = previous.window;
    (globals as unknown as { upstream?: unknown }).upstream = previous.upstream;
    globals.fetch = previous.fetch as typeof globalThis.fetch;
  }

  return windowStub[BRIDGE_KEY] as {
    resolveIntegrity: () => string;
    requestClient: { safePost: (path: string, options?: unknown) => Promise<unknown> };
  };
}

describe("chatgpt.com integrity module dependency shim", () => {
  it("knows both names the page build has used for the UUID helper", () => {
    assert.deepEqual([...UUID_DEPENDENCY_IDS], ["TI", "DD"]);
  });

  it("satisfies the helper for the current build id (DD)", async () => {
    const bridge = await runBridge(CONTRACT, ["DD"]);
    assert.match(bridge.resolveIntegrity(), /^[0-9a-f-]{36}$/i);
  });

  it("still satisfies the previous build id (TI)", async () => {
    const bridge = await runBridge(CONTRACT, ["TI"]);
    assert.match(bridge.resolveIntegrity(), /^[0-9a-f-]{36}$/i);
  });

  it("fails loudly for a genuinely unknown module instead of faking a token", async () => {
    await assert.rejects(
      () => runBridge(CONTRACT, ["ZZ"]),
      /Unsupported ChatGPT integrity dependency: ZZ/
    );
  });

  it("tells the operator how to fix a future rename", async () => {
    await assert.rejects(
      () => runBridge(CONTRACT, ["ZZ"]),
      /add the new id to UUID_DEPENDENCY_IDS/,
      "the error must name the fix, because this recurs with every page build"
    );
  });

  it("keeps the legacy contract path free of the integrity shim", () => {
    const source = buildBridgeModuleSource(ASSET_URL, {
      ...CONTRACT,
      resolveIntegrity: undefined,
      resolveIntegrityModule: undefined,
    });
    assert.match(source, /proofManager/);
    assert.doesNotMatch(source, /requireShim/);
  });

  it("refuses to build a bridge from a non-ChatGPT asset url", () => {
    assert.throws(
      () => buildBridgeModuleSource("https://evil.example/cdn/assets/app.js", CONTRACT),
      /invalid first-party asset URL/
    );
  });
});
