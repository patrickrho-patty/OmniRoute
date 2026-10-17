#!/usr/bin/env node
/**
 * ad-hoc A/B: plain Playwright Chromium vs CloakBrowser on anti-bot surfaces.
 *
 * Why this exists: the browser-backed providers (cloudflare-playground, web-cookie
 * providers) sit behind Cloudflare/DuckDuckGo anti-bot. The repo comment in
 * open-sse/services/browserPool.ts claims only cloakbrowser's binary-level fingerprint
 * patches clear that. This script measures it instead of trusting the comment.
 *
 * Usage: node scripts/ad-hoc/cloakbrowser-ab.mjs
 */
import { chromium } from "playwright";

const TARGETS = [
  { name: "cloudflare playground", url: "https://playground.ai.cloudflare.com/" },
  { name: "duckduckgo html", url: "https://duckduckgo.com/html/?q=omniroute" },
  { name: "creepjs fingerprint", url: "https://abrahamjuliot.github.io/creepjs/" },
];

const CHALLENGE_MARKERS = [
  "attention required",
  "just a moment",
  "checking your browser",
  "verify you are human",
  "enable javascript and cookies",
  "access denied",
  "captcha",
];

function classify(title, body) {
  const haystack = `${title}\n${body}`.toLowerCase();
  const hit = CHALLENGE_MARKERS.find((marker) => haystack.includes(marker));
  return hit ? `BLOCKED (${hit})` : "OK";
}

async function probe(engineName, launch) {
  const results = [];
  let browser;
  try {
    browser = await launch();
  } catch (error) {
    return [{ target: "(launch)", verdict: `LAUNCH FAILED: ${error.message}` }];
  }
  try {
    for (const target of TARGETS) {
      const page = await browser.newPage();
      try {
        const response = await page.goto(target.url, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        await page.waitForTimeout(2500);
        const title = await page.title().catch(() => "");
        const body = (await page.content().catch(() => "")).slice(0, 20000);
        results.push({
          target: target.name,
          status: response?.status() ?? "no-response",
          verdict: classify(title, body),
          title: title.slice(0, 70),
        });
      } catch (error) {
        results.push({ target: target.name, verdict: `NAV FAILED: ${error.message}` });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n## ${engineName}`);
  for (const r of results) {
    console.log(
      `  ${r.target.padEnd(24)} ${String(r.status ?? "-").padEnd(5)} ${r.verdict}` +
        (r.title ? `  title="${r.title}"` : "")
    );
  }
}

const { launch: cloakLaunch } = await import("cloakbrowser").catch(() => ({ launch: null }));

if (!cloakLaunch) {
  console.log("cloakbrowser is not installed — nothing to compare");
  process.exit(1);
}

await probe("plain Playwright Chromium", () => chromium.launch({ headless: true }));
await probe("CloakBrowser", () =>
  cloakLaunch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
);
