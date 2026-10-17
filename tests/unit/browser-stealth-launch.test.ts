import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  __setStealthEngineOverrides,
  launchStealthBrowser,
} from "../../open-sse/services/browserPool.ts";

import type { Browser } from "playwright";

/**
 * The optional browser engines (CloakBrowser, Obscura) resolve through computed dynamic
 * imports and real Chromium launches, so precedence and degradation are exercised here with
 * stubbed engines. A missing optional engine must never fail the provider call: every case
 * ends on plain Playwright Chromium.
 */

const fakeBrowser = (label: string) => ({ __engine: label }) as unknown as Browser;

const restoreEnv: Array<() => void> = [];

afterEach(() => {
  __setStealthEngineOverrides(null);
  while (restoreEnv.length) restoreEnv.pop()?.();
});

function setPoolFlag(value: string | undefined) {
  const previous = process.env.OMNIROUTE_BROWSER_POOL;
  process.env.OMNIROUTE_BROWSER_POOL = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env.OMNIROUTE_BROWSER_POOL;
    else process.env.OMNIROUTE_BROWSER_POOL = previous;
  });
}

describe("launchStealthBrowser engine precedence", () => {
  it("prefers CloakBrowser when the caller asks for it (anti-bot providers)", async () => {
    let obscuraCalls = 0;
    __setStealthEngineOverrides({
      cloakbrowser: async () => async () => fakeBrowser("cloak"),
      obscura: async () => {
        obscuraCalls += 1;
        return { browser: fakeBrowser("obscura") };
      },
    });

    const { browser, engine } = await launchStealthBrowser({ preferCloakbrowser: true });

    assert.equal(engine, "cloakbrowser");
    assert.equal((browser as unknown as { __engine: string }).__engine, "cloak");
    assert.equal(obscuraCalls, 0, "Obscura must not be started when cloak already answered");
  });

  it("keeps Obscura first when the caller has no stealth preference", async () => {
    __setStealthEngineOverrides({
      cloakbrowser: async () => async () => fakeBrowser("cloak"),
      obscura: async () => ({ browser: fakeBrowser("obscura") }),
    });

    const { engine } = await launchStealthBrowser();

    assert.equal(engine, "obscura", "the default order must stay Obscura → cloakbrowser");
  });

  it("falls through to Obscura when CloakBrowser is installed but fails to launch", async () => {
    __setStealthEngineOverrides({
      cloakbrowser: async () => async () => {
        throw new Error("cloakbrowser binary download failed");
      },
      obscura: async () => ({ browser: fakeBrowser("obscura") }),
    });

    const { engine } = await launchStealthBrowser({ preferCloakbrowser: true });

    assert.equal(engine, "obscura", "a broken optional engine must not fail the call");
  });

  it("falls back to plain Playwright when no stealth engine is available", async () => {
    __setStealthEngineOverrides({
      cloakbrowser: async () => null,
      obscura: async () => null,
      chromium: async () => fakeBrowser("chromium"),
    });

    const { engine } = await launchStealthBrowser({ preferCloakbrowser: true });

    assert.equal(engine, "chromium");
  });

  it("stays on plain Playwright when OMNIROUTE_BROWSER_POOL is off", async () => {
    setPoolFlag("off");
    let stealthCalls = 0;
    __setStealthEngineOverrides({
      cloakbrowser: async () => {
        stealthCalls += 1;
        return async () => fakeBrowser("cloak");
      },
      obscura: async () => {
        stealthCalls += 1;
        return { browser: fakeBrowser("obscura") };
      },
      chromium: async () => fakeBrowser("chromium"),
    });

    const { engine } = await launchStealthBrowser({ preferCloakbrowser: true });

    assert.equal(engine, "chromium");
    assert.equal(stealthCalls, 0, "the pool kill switch must also disable the stealth path");
  });

  it("uses plain Playwright for headed launches (stealth engines here are headless)", async () => {
    let stealthCalls = 0;
    __setStealthEngineOverrides({
      cloakbrowser: async () => {
        stealthCalls += 1;
        return async () => fakeBrowser("cloak");
      },
      chromium: async () => fakeBrowser("chromium"),
    });

    const { engine } = await launchStealthBrowser({ headless: false, preferCloakbrowser: true });

    assert.equal(engine, "chromium");
    assert.equal(stealthCalls, 0);
  });
});
