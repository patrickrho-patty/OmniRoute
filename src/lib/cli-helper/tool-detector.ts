import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentHermesAgentRoles } from "./config-generator/hermes-agent";
import { getCachedLoginShellPath, mergeShellPath } from "@/shared/services/loginShellPath";
import { getRuntimePorts } from "@/lib/runtime/ports";
import { getHermesConfigPath } from "./config-generator/hermesHome";
import { getCliTool, listCliTools } from "../../shared/constants/cliTools";
import {
  CLI_TOOL_IDS,
  getLookupEnv,
  getCliPrimaryConfigPath,
  getCliToolCommandCandidates,
  normalizeCliToolId,
  shouldUseShellForCommand,
} from "../../shared/services/cliRuntime";
import { resolveOpencodeConfigPath } from "../../shared/services/opencodeConfigPath";

const execFileAsync = promisify(execFile);
let execFileImpl = execFileAsync;

// #3321: macOS GUI/Electron truncates PATH, so `which`/`--version` probes miss Homebrew/
// nvm/volta CLIs and the doctor reports them "not installed". Build a lookup env enriched
// with the login-shell PATH (darwin-only, cached, fail-safe → returns process.env elsewhere).
function _detectorEnv(): NodeJS.ProcessEnv {
  const loginShellPath = getCachedLoginShellPath();
  if (!loginShellPath) return process.env;
  return { ...process.env, PATH: mergeShellPath(process.env.PATH || "", loginShellPath) };
}

export function __setExecFileImpl(fn: typeof execFileAsync): void {
  execFileImpl = fn;
}

export interface DetectedTool {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  configPath: string;
  configured: boolean;
  configContents?: string;

  // Rich per-role status for Hermes Agent
  hermesAgentRoles?: Record<
    string,
    {
      model: string;
      provider?: string;
      usingOmniRoute: boolean;
    }
  >;
}

type ToolDescriptor = { id: string; name: string; configPath: string };

// Keep the long-standing CLI status labels stable while the UI catalog uses
// marketing names (for example, "Open Claw").
const DETECTOR_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  openclaw: "OpenClaw",
};

/**
 * The detector is a read-only view over the shared runtime/UI catalogs.
 * Runtime-only entries (for example qoder) are retained, while guide-only UI
 * entries still appear with an empty config path and `installed: false`.
 */
const TOOLS: ToolDescriptor[] = Array.from(
  new Set([...listCliTools().map((tool) => tool.id), ...CLI_TOOL_IDS])
).map((id) => ({
  id,
  name: DETECTOR_NAME_OVERRIDES[id] || getCliTool(id)?.name || id,
  configPath: "",
}));

function expandHome(p: string): string {
  const home = os.homedir();
  return p.replace(/^~\//, home + "/");
}

function isConfigured(content: string, baseUrl: string): boolean {
  const normalized = baseUrl.replace(/\/+$/, "");
  // Heuristic: a tool is "configured for OmniRoute" when its config either
  // contains the literal base URL, or references the runtime port (handles
  // both the historical :20128 default and deployments that override PORT).
  const runtimePort = String(getRuntimePorts().port);
  return (
    content.includes(normalized) ||
    content.includes(`localhost:${runtimePort}`) ||
    content.includes("OMNIROUTE_BASE_URL")
  );
}

// #968/#7279: on native Windows, npm installs CLI wrappers (claude/codex/opencode/…)
// as .cmd/.bat shims. Node's CVE-2024-27980 hardening makes execFile()/spawn() reject
// those without `shell: true`, and the `which` fallback below doesn't exist natively
// on Windows (no WSL/git-bash) — so both probes threw, both were swallowed, and an
// installed CLI was reported as absent. Reuse cliRuntime.ts's `locateCommand`
// (already win32-aware since #968: `where.exe` + `.cmd`/`.exe`/`.bat`/`.com`
// preference) for existence/path, then probe `--version` with `shell: true` when the
// resolved binary needs it. If this drifts again, check cliRuntime.ts first.
async function detectBinaryWindows(
  binary: string,
  env: NodeJS.ProcessEnv
): Promise<{ installed: boolean; version?: string }> {
  const located = await locateCommandImpl(binary, env);
  if (!located.installed || !located.commandPath) return { installed: false };

  try {
    const useShell = shouldUseShellForCommand(located.commandPath);
    const { stdout } = await execFileImpl(located.commandPath, ["--version"], {
      timeout: 5000,
      env,
      windowsHide: true,
      ...(useShell ? { shell: true, windowsVerbatimArguments: true } : {}),
    });
    return { installed: true, version: stdout.trim().replace(/^v/, "") };
  } catch {
    // Binary exists on PATH but the --version probe failed (unusual flag, slow
    // startup, etc.) — still report it as installed since locateCommand confirmed it.
    return { installed: true };
  }
}

async function detectBinary(name: string): Promise<{ installed: boolean; version?: string }> {
  const binaries = getCliToolCommandCandidates(name);
  if (binaries.length === 0) return { installed: false };
  const env = getLookupEnv();

  for (const binary of binaries) {
    if (process.platform === "win32") {
      const result = await detectBinaryWindows(binary, env);
      if (result.installed) return result;
      continue;
    }

    try {
      const { stdout } = await execFileImpl(binary, ["--version"], { timeout: 5000, env });
      const version = stdout.trim().replace(/^v/, "");
      return { installed: true, version };
    } catch {
      try {
        // Try `which` as fallback (routed through execFileImpl so it stays mockable)
        const { stdout } = await execFileImpl("which", [binary], { timeout: 5000, env });
        if (stdout.trim()) {
          return { installed: true };
        }
      } catch {
        // Try the next declared command candidate.
      }
    }
  }

  return { installed: false };
}

async function readConfigFile(configPath: string): Promise<string | null> {
  try {
    const { readFileSync } = await import("node:fs");
    const expanded = expandHome(configPath);
    if (!expanded) return null;
    return readFileSync(expanded, "utf-8");
  } catch {
    return null;
  }
}

export async function detectTool(id: string): Promise<DetectedTool | null> {
  const canonicalId = normalizeCliToolId(id);
  const tool = TOOLS.find((t) => t.id === canonicalId);
  if (!tool) return null;

  const { installed, version } = await detectBinary(tool.id);
  const configPath =
    tool.id === "hermes" || tool.id === "hermes-agent"
      ? getHermesConfigPath()
      : getCliPrimaryConfigPath(tool.id) ||
        (tool.id === "opencode" ? resolveOpencodeConfigPath() : "");
  const configContents = await readConfigFile(configPath);
  const configured = !!configContents && isConfigured(configContents, "http://localhost:20128");

  const result: DetectedTool = {
    id: canonicalId,
    name: tool.name,
    installed,
    version,
    configPath,
    configured,
    configContents: configContents ?? undefined,
  };

  // Rich per-role status only for Hermes Agent
  if (tool.id === "hermes-agent") {
    try {
      const roles = await getCurrentHermesAgentRoles();
      const richRoles: Record<string, any> = {};

      Object.entries(roles).forEach(([role, info]) => {
        const usingOmni =
          info?.provider === "omniroute" ||
          (info?.base_url || "").includes(`:${getRuntimePorts().port}`);

        richRoles[role] = {
          model: info.model,
          provider: info.provider,
          usingOmniRoute: usingOmni,
        };
      });

      result.hermesAgentRoles = richRoles;
    } catch {
      // ignore – rich status is optional
    }
  }

  return result;
}

export async function detectAllTools(): Promise<DetectedTool[]> {
  const results = await Promise.allSettled(TOOLS.map((t) => detectTool(t.id)));

  return results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => (r as PromiseFulfilledResult<DetectedTool>).value);
}
