/**
 * Regression guard for the "vertical text" report on Provider Quota cards.
 *
 * On a 320px card the fixed-width right-side cluster (reset chip + test/toggle buttons) used to
 * squeeze the account block to ~42px, which rendered "Token expires in 0h 15m" one character per
 * line and clipped the e-mail to `da…`. The header now keeps a width floor and wraps its chips to
 * a second row, and the account line wraps instead of truncating.
 *
 * Measured before/after (same fixture, 48px chip emulated, Playwright at 1600x1000):
 *   account block  42px  → 156px
 *   expiry label   4 lines → 1 line
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...segments: string[]) => fs.readFileSync(path.join(repoRoot, ...segments), "utf8");

const headerSource = read(
  "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/parts/QuotaCardHeader.tsx"
);
const gridSource = read(
  "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaCardGrid.tsx"
);

test("the card header wraps its chips instead of squeezing the account block", () => {
  const row = headerSource.match(/<div className="flex min-h-\[62px\][^"]*"/);
  assert.ok(row, "must find the header row element");
  assert.match(row[0], /flex-wrap/, "header row must wrap so the chips can move to a new line");
});

test("the account block keeps a width floor so the token-expiry label cannot go vertical", () => {
  const block = headerSource.match(/<div className="flex min-w-0 flex-1 [^"]*items-center gap-2"/);
  assert.ok(block, "must find the account block");
  assert.match(
    block[0],
    /basis-\[11rem\]/,
    "account block needs a flex-basis floor; without it the shrink-0 chips collapse it"
  );
});

test("the account/e-mail line shows the full value instead of truncating it", () => {
  const accountLine = headerSource.match(
    /<span\s+className="[^"]*text-\[11px\][^"]*"\s+title=\{accountName/
  );
  assert.ok(accountLine, "must find the account-name span");
  assert.doesNotMatch(
    accountLine[0],
    /\btruncate\b/,
    "the account line must not truncate — operators asked for the full e-mail"
  );
  assert.match(accountLine[0], /break-words/, "long values must wrap rather than overflow");
});

test("quota cards are wide enough for a full e-mail address", () => {
  assert.match(gridSource, /full: "w-full sm:w-\[320px\]"/);
  assert.match(gridSource, /compact: "w-full sm:w-\[296px\]"/);
});
