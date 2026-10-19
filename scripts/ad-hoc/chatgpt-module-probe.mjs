#!/usr/bin/env node
/**
 * ad-hoc: discover what an unsupported ChatGPT webpack module id exports.
 *
 * The clean-room bridge instantiates chatgpt.com's own integrity module through a fake
 * webpack `require`. That shim only knows the ids observed so far ("TI"); when the page's
 * build asks for a new one the bridge dies with
 * `Unsupported ChatGPT integrity dependency: <id>`. This script loads the live bundle and
 * prints how the id is called and what the module factory behind it returns.
 *
 * Usage: node scripts/ad-hoc/chatgpt-module-probe.mjs <ID> [<ID> ...]
 */
import { chromium } from "playwright";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: chatgpt-module-probe.mjs <MODULE_ID> [...]");
  process.exit(1);
}

const { launch: cloakLaunch } = await import("cloakbrowser").catch(() => ({ launch: null }));
const browser = await (cloakLaunch
  ? cloakLaunch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  : chromium.launch({ headless: true }));

const page = await browser.newPage();
await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);

const scriptUrls = await page.evaluate(() =>
  performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".js"))
);

console.log(`loaded ${scriptUrls.length} scripts`);

const sources = [];
for (const url of scriptUrls) {
  const text = await page.evaluate(async (u) => {
    try {
      const response = await fetch(u, { credentials: "include" });
      return response.ok ? await response.text() : "";
    } catch {
      return "";
    }
  }, url);
  if (text) sources.push({ url, text });
}
console.log(`fetched ${sources.length} script bodies\n`);

for (const id of ids) {
  console.log(`===== module id ${id} =====`);
  let found = 0;
  for (const { url, text } of sources) {
    // Call sites: any minified require(...) that asks for this id.
    const callRe = new RegExp(`\\("${id}"\\)`, "g");
    for (const match of text.matchAll(callRe)) {
      const start = Math.max(0, match.index - 220);
      console.log(`--- call site in ${url.split("/").pop()}`);
      console.log(text.slice(start, match.index + 120).replace(/\s+/g, " "));
      if (++found >= 4) break;
    }
    if (found >= 4) break;
  }
  if (found === 0) console.log("(no call sites found)");

  // Factory definition: webpack module maps declare `<id>:(params)=>{...}` or `<id>:function`.
  for (const { url, text } of sources) {
    const defRe = new RegExp(`(?:^|[,{])\\s*"?${id}"?\\s*:\\s*(?:\\(|function)`, "m");
    const def = defRe.exec(text);
    if (!def) continue;
    console.log(`--- factory in ${url.split("/").pop()}`);
    console.log(text.slice(def.index, def.index + 700).replace(/\s+/g, " "));
    break;
  }
  console.log("");
}

await browser.close();
