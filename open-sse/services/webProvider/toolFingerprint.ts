import { createHash } from "node:crypto";

import { WEB_TOOL_PROTOCOL_VERSION } from "./toolContract.ts";

export function buildWebToolContractFingerprint(tools: unknown, toolChoice: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        protocol: WEB_TOOL_PROTOCOL_VERSION,
        toolChoice: toolChoice ?? "auto",
        tools: tools ?? [],
      })
    )
    .digest("hex");
}
