import { execFile } from "node:child_process";

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

const RESTART_DELAY_MS = 500;
const SYSTEMD_RESTART_DELAY = "1s";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/bin/systemctl";
const OMNIROUTE_SERVICE = "omniroute.service";

export type RestartPlan =
  | { kind: "systemd"; command: string; args: string[] }
  | { kind: "signal"; pid: number; signal: NodeJS.Signals };

export function resolveRestartPlan(env: NodeJS.ProcessEnv = process.env): RestartPlan {
  const manager = env.OMNIROUTE_RESTART_MANAGER?.toLowerCase();
  const isSystemd =
    manager === "systemd" ||
    (manager !== "signal" && process.platform === "linux" && !!env.INVOCATION_ID);

  if (isSystemd) {
    const unit = `omniroute-web-restart-${process.pid}-${Date.now()}`;
    return {
      kind: "systemd",
      command: SYSTEMD_RUN,
      args: [
        "--unit",
        unit,
        "--on-active",
        SYSTEMD_RESTART_DELAY,
        "--collect",
        SYSTEMCTL,
        "restart",
        OMNIROUTE_SERVICE,
      ],
    };
  }

  return { kind: "signal", pid: process.pid, signal: "SIGTERM" };
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runRestartPlan(plan: RestartPlan): Promise<void> {
  if (plan.kind === "systemd") {
    try {
      await execFileAsync(plan.command, plan.args);
      return;
    } catch (error) {
      console.error("[Restart] systemd-run failed; falling back to SIGTERM", error);
    }
  }

  process.kill(process.pid, "SIGTERM");
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const plan = resolveRestartPlan();
  setTimeout(() => {
    void runRestartPlan(plan);
  }, RESTART_DELAY_MS);

  return NextResponse.json({ status: "restarting", method: plan.kind });
}
