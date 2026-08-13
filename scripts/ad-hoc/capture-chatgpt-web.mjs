import { chromium } from "playwright";
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";

const COOKIE_DB = "/tmp/firefox-cookies.sqlite";
const OUT_FILE = "/tmp/chatgpt-web-capture.json";

function loadCookies() {
  const db = new Database(COOKIE_DB);
  const rows = db
    .prepare(
      "SELECT host, name, value, path FROM moz_cookies WHERE host LIKE ? OR host LIKE ? OR host LIKE ? OR host LIKE ? ORDER BY host, name"
    )
    .all("%chatgpt.com", "%openai.com", "%auth.openai.com", "%.files.openai.com");
  db.close();
  // Deduplicate: take the newest/most complete session token pair. Firefox stores
  // duplicate cookies for different container contexts; we want the active ChatGPT
  // Web session (not Codex). Codex cookies have app_name_enum "oaici" in
  // oai-client-auth-session; ChatGPT Web has "chat". We use the ChatGPT session
  // token with the longer value as the active one.
  const byHostName = new Map();
  for (const r of rows) {
    const key = `${r.host}|${r.name}`;
    const existing = byHostName.get(key);
    if (!existing || r.value.length > existing.value.length) {
      byHostName.set(key, r);
    }
  }
  return Array.from(byHostName.values()).map((r) => ({
    name: r.name,
    value: r.value,
    domain: r.host.startsWith(".") ? r.host : `.${r.host}`,
    path: r.path,
    httpOnly: true,
    secure: true,
    sameSite: "None",
  }));
}

async function main() {
  const cookies = loadCookies();
  console.log(`loaded ${cookies.length} cookies`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  await context.addCookies(cookies);

  const captured = [];
  context.on("page", (page) => {
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/backend-api/f/conversation") && req.method() === "POST") {
        const body = req.postData();
        captured.push({
          url,
          headers: req.headers(),
          body: body ? JSON.parse(body) : null,
          timestamp: new Date().toISOString(),
        });
        console.log("CAPTURED", url);
      }
    });
  });

  const page = await context.newPage();
  await page.goto("https://chatgpt.com/?temporary-chat=true", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  await page.screenshot({ path: "/tmp/chatgpt-web-screenshot.png", fullPage: true });
  writeFileSync("/tmp/chatgpt-web-page.html", await page.content());

  // Dismiss any modals / accept cookies if present.
  try {
    await page
      .getByRole("button", { name: /dismiss|close|got it/i })
      .first()
      .click({ timeout: 3000 });
  } catch {}

  // Type a simple message and submit.
  const prompt = "hello, what is 2+2?";
  const textarea = page
    .locator('textarea[id="prompt-textarea"], textarea[placeholder*="Message"]')
    .first();
  await textarea.fill(prompt);
  await textarea.press("Enter");

  // Wait for the conversation request and some response chunks.
  await page.waitForTimeout(8000);

  writeFileSync(OUT_FILE, JSON.stringify(captured, null, 2));
  console.log(`wrote ${captured.length} requests to ${OUT_FILE}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
