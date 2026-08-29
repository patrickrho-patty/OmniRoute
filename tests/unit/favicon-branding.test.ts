import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRAND_ASSET_VERSION = "patty-p-dot-20260830";

const layoutSource = readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8");
const manifestSource = readFileSync(join(ROOT, "src/app/manifest.ts"), "utf8");
const serviceWorkerSource = readFileSync(join(ROOT, "public/sw.js"), "utf8");

const versionedPath = (path: string): string => `${path}?v=${BRAND_ASSET_VERSION}`;

test("root metadata cache-busts every default favicon URL", () => {
  assert.ok(layoutSource.includes(versionedPath("/favicon.ico")));
  assert.ok(layoutSource.includes(versionedPath("/icon-512.png")));
});

test("web manifest cache-busts every Patty app icon URL", () => {
  assert.ok(manifestSource.includes(versionedPath("/icon-192.png")));
  assert.ok(manifestSource.includes(versionedPath("/icon-512.png")));
});

test("service worker advances its cache and preloads only versioned Patty icons", () => {
  assert.ok(serviceWorkerSource.includes('const CACHE_NAME = "omniroute-pwa-v4"'));
  assert.ok(serviceWorkerSource.includes(versionedPath("/icon-192.png")));
  assert.ok(serviceWorkerSource.includes(versionedPath("/icon-512.png")));
});
