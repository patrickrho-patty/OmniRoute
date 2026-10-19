import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const failed = [];
page.on("response", (r) => {
  if (r.status() >= 400)
    failed.push(`${r.status()} ${r.url().replace("http://localhost:20129", "")}`);
});
await page.goto("http://localhost:20129/dashboard/quota", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(9000);
const info = await page.evaluate(() => ({
  title: document.title,
  bodyText: document.body.innerText.slice(0, 220),
  cards: document.querySelectorAll("[data-quota-card], .quota-card").length,
  hasQuotaHeading: /provider limits|provider quota/i.test(document.body.innerText),
}));
console.log(JSON.stringify(info, null, 2));
console.log("failed requests:", [...new Set(failed)].slice(0, 8));
await page.screenshot({ path: "/tmp/quota-probe.png" });
await browser.close();
