#!/usr/bin/env node
/**
 * Render /dashboard/quota with stubbed connections, emulate the reset chip that squeezes the
 * header, and measure what the operator actually sees: how wide the text column is, whether the
 * token-expiry line goes vertical, and whether the account/email is readable in full.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:20129/dashboard/quota";
const shot = process.argv[3] ?? "/tmp/quota-card.png";
const connections = readFileSync("/tmp/mock-connections.json", "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// Turn on "show emails" (persisted zustand store) so the account line is measured unmasked.
await page.addInitScript(() => {
  window.localStorage.setItem(
    "omniroute-email-privacy",
    JSON.stringify({ state: { emailsVisible: true }, version: 0 })
  );
});
await page.route("**/api/providers/client*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: connections })
);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);

// Emulate the reset chip ("4h 2m") that the real quota payload adds to the header's right side —
// it is what shrinks the text column on a live page.
await page.evaluate(() => {
  for (const header of document.querySelectorAll('div[class*="min-h-[62px]"]')) {
    const spacer = document.createElement("span");
    spacer.className = "qc-chip-spacer";
    spacer.style.cssText = "flex:0 0 auto;width:48px;height:20px;display:block";
    header.insertBefore(spacer, header.children[1] ?? null);
  }
});
await page.waitForTimeout(1200);

const report = await page.evaluate(() => {
  const headers = [...document.querySelectorAll('div[class*="min-h-[62px]"]')];
  const header = headers[0];
  const textColumn = header?.children[0]?.children[2];
  const emailSpan = header?.querySelector('span[class*="text-text-muted"]');
  const expiry = [...(header?.querySelectorAll("span") ?? [])].find((s) =>
    /token expires|token expired/i.test(s.textContent || "")
  );
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const lines = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) || 12;
    return Math.round(el.getBoundingClientRect().height / lineHeight);
  };
  return {
    cards: headers.length,
    cardWidth: Math.round(header?.getBoundingClientRect().width ?? 0),
    textColumnWidth: textColumn ? Math.round(rect(textColumn).width) : null,
    email: {
      text: (emailSpan?.textContent || "").trim(),
      boxWidth: emailSpan ? Math.round(rect(emailSpan).width) : null,
      lines: lines(emailSpan),
      clipped: emailSpan ? emailSpan.scrollWidth > emailSpan.clientWidth + 1 : null,
    },
    expiry: {
      text: (expiry?.textContent || "").trim().slice(0, 40),
      boxWidth: expiry ? Math.round(rect(expiry).width) : null,
      lines: lines(expiry),
    },
  };
});
console.log(JSON.stringify(report, null, 2));
await page.screenshot({ path: shot });
console.log("screenshot:", shot);
await browser.close();
