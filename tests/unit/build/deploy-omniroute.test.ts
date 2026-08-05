import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const deployScript = readFileSync(resolve(process.cwd(), "scripts/deploy-omniroute.sh"), "utf8");

test("deploy script excludes only the root coverage artifact directory", () => {
  assert.match(deployScript, /--exclude='\/coverage\/'/);
  assert.doesNotMatch(deployScript, /--exclude='coverage\/'/);
});
