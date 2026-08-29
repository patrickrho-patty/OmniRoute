import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import manifest from "../../src/app/manifest";
import { readSrc, REPO_ROOT } from "../_helpers/readSrc";

const PUBLIC_DIR = path.join(REPO_ROOT, "public");

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("canonical Patty icons match the approved P-dot artwork", () => {
  assert.equal(
    sha256(path.join(PUBLIC_DIR, "favicon.ico")),
    "676905309304454b407de317ee1c3cd21bccca871ce2d1c42462bcc077c25739"
  );
  assert.equal(
    sha256(path.join(PUBLIC_DIR, "icon-192.png")),
    "7f8f23c431825305962ff554ae17a7a74212322bae074498e2fd957c0bf9666f"
  );
  assert.equal(
    sha256(path.join(PUBLIC_DIR, "icon-512.png")),
    "c654da0032b5313e619d3153864408cda7649499a7503699386b4c69034c72be"
  );
});

test("legacy red-bar brand assets and their generator are removed", () => {
  const legacyPaths = [
    "public/apple-touch-icon.png",
    "public/apple-touch-icon.svg",
    "public/favicon.svg",
    "public/icon-192.svg",
    "scripts/ad-hoc/generate-brand-icons.mjs",
  ];

  for (const legacyPath of legacyPaths) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, legacyPath)), false, legacyPath);
  }
});

test("web and PWA consumers use only the canonical Patty icons", () => {
  const manifestIcons = manifest().icons ?? [];
  assert.deepEqual(manifestIcons, [
    {
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
  ]);

  const consumerPaths = [
    "src/app/layout.tsx",
    "src/app/api/settings/favicon/route.ts",
    "public/sw.js",
  ];
  const consumers = consumerPaths.map(readSrc);

  for (const source of consumers) {
    assert.doesNotMatch(source, /\/(?:apple-touch-icon(?:\.png|\.svg)|favicon\.svg|icon-192\.svg)/);
  }

  assert.match(consumers[0], /url: "\/favicon\.ico"/);
  assert.match(consumers[0], /apple: \[\{ url: "\/icon-512\.png"/);
  assert.match(consumers[1], /defaultFaviconRedirect\(request\)/);
  assert.match(consumers[2], /const CACHE_NAME = "omniroute-pwa-v3"/);
  assert.match(consumers[2], /"\/icon-192\.png"/);
  assert.match(consumers[2], /"\/icon-512\.png"/);
  assert.match(consumers[2], /\.\.\.\(data\.badge \? \{ badge: data\.badge \} : \{\}\)/);
  assert.doesNotMatch(consumers[2], /badge: data\.badge \|\|/);
  assert.doesNotMatch(consumers[2], /badge:\s*["']\/icon-/);
});

test("default favicon fallback redirects to an absolute same-origin URL", async () => {
  const route = await import("../../src/app/api/settings/favicon/route");
  assert.equal(typeof route.defaultFaviconRedirect, "function");

  const response = route.defaultFaviconRedirect(
    new Request("https://patty.example/api/settings/favicon")
  );
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://patty.example/favicon.ico");
});

test("default favicon fallback preserves the configured deployment base path", async () => {
  const previousBasePath = process.env.OMNIROUTE_BASE_PATH;
  const previousPublicBasePath = process.env.NEXT_PUBLIC_OMNIROUTE_BASE_PATH;

  process.env.OMNIROUTE_BASE_PATH = "/omniroute";
  delete process.env.NEXT_PUBLIC_OMNIROUTE_BASE_PATH;

  try {
    const route = await import("../../src/app/api/settings/favicon/route");
    const response = route.defaultFaviconRedirect(
      new Request("https://patty.example/omniroute/api/settings/favicon")
    );

    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://patty.example/omniroute/favicon.ico");
  } finally {
    if (previousBasePath === undefined) {
      delete process.env.OMNIROUTE_BASE_PATH;
    } else {
      process.env.OMNIROUTE_BASE_PATH = previousBasePath;
    }

    if (previousPublicBasePath === undefined) {
      delete process.env.NEXT_PUBLIC_OMNIROUTE_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_OMNIROUTE_BASE_PATH = previousPublicBasePath;
    }
  }
});
