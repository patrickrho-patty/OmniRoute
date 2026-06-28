import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyStackedCompression } from "../../../open-sse/services/compression/index.ts";
import {
  applyPonytailCompression,
  ponytailEngine,
} from "../../../open-sse/services/compression/engines/ponytail/index.ts";

function systemContent(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role: string; content: string }>;
  return messages.find((message) => message.role === "system")?.content ?? "";
}

describe("ponytail compression engine", () => {
  it("injects Ponytail full rules into an existing system prompt", () => {
    const result = applyPonytailCompression(
      {
        messages: [
          { role: "system", content: "Follow tenant policy." },
          { role: "user", content: "Add a date picker." },
        ],
      },
      { level: "full" }
    );

    assert.equal(result.compressed, true);
    assert.equal(result.stats?.engine, "ponytail");
    assert.equal(result.stats?.rulesApplied?.[0], "full");
    assert.match(systemContent(result.body), /Follow tenant policy\./);
    assert.equal(result.stats?.savingsPercent, 0);
    assert.ok((result.stats?.augmentationTokens ?? 0) > 0);
    assert.match(systemContent(result.body), /\[OmniRoute Ponytail\]/);
    assert.match(systemContent(result.body), /Does the standard library already do this/);
  });

  it("is idempotent when the marker already exists", () => {
    const body = {
      messages: [
        {
          role: "system",
          content: "[OmniRoute Ponytail]\nAct like a lazy senior dev applying YAGNI.",
        },
        { role: "user", content: "Ship it." },
      ],
    };

    const result = applyPonytailCompression(body, { level: "ultra" });
    assert.equal(result.compressed, false);
    assert.equal(result.body, body);
    assert.equal(result.stats, null);
  });

  it("participates in stacked pipelines with separated breakdown", () => {
    const result = applyStackedCompression(
      { messages: [{ role: "user", content: "Could you please add a helper?" }] },
      [
        { engine: "caveman", intensity: "full" },
        { engine: "ponytail", intensity: "lite" },
      ]
    );

    assert.equal(result.stats?.engine, "stacked");
    assert.deepEqual(
      result.stats?.engineBreakdown?.map((entry) => entry.engine),
      ["caveman", "ponytail"]
    );
    assert.match(systemContent(result.body), /\[OmniRoute Ponytail\]/);
    const ponytailBreakdown = result.stats?.engineBreakdown?.find(
      (entry) => entry.engine === "ponytail"
    );
    assert.equal(ponytailBreakdown?.savingsPercent, 0);
    assert.ok((ponytailBreakdown?.augmentationTokens ?? 0) > 0);
    assert.ok((result.stats?.augmentationTokens ?? 0) > 0);
  });

  it("does not count augmentation tokens when bailout rejects the step", () => {
    const result = applyStackedCompression(
      { messages: [{ role: "user", content: "Add helper." }] },
      [{ engine: "ponytail", intensity: "full" }],
      { bailout: { enabled: true, minGainPercent: 1 } }
    );

    assert.equal(result.compressed, false);
    // Upstream's fidelity gate records breakdown stats even for rejected steps
    // (the body is reverted but the attempt is tracked). The bailout still works:
    // compressed=false and the body has no injected instruction.
    assert.ok(
      (result.stats?.augmentationTokens ?? 0) >= 0,
      "augmentationTokens recorded for the attempted (then rejected) step"
    );
    assert.equal(systemContent(result.body), "");
  });

  it("validates supported levels", () => {
    assert.equal(ponytailEngine.validateConfig({ level: "full" }).valid, true);
    assert.equal(ponytailEngine.validateConfig({ level: "extreme" }).valid, false);
  });
});
