import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const enabled = process.env.PATTY_PACKAGED_GATEWAY_LIVE === "1";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

async function waitForHealth(port: number, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`packaged runner exited early (${child.exitCode})\n${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/ping`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Build startup is intentionally noisy and can take several seconds.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`packaged runner did not become healthy\n${output()}`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

function requestHeaders(harness: "claude" | "codex") {
  return {
    authorization: "Bearer packaged-runner-key",
    "content-type": "application/json",
    "x-patty-harness": harness,
    "x-patty-original-authorization": "employee-canary-token",
    "x-patty-client-ip": "10.0.0.7",
    "x-patty-account-id": "employee-1",
  };
}

test(
  "packaged runner enforces Patty quota before HTTP and Responses WebSocket provider work",
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const standalone = path.join(repoRoot, ".build", "next", "standalone");
    const runner = path.join(standalone, "dev", "run-standalone.mjs");
    assert.ok(
      fs.existsSync(runner),
      "npm run build must create .build/next/standalone/dev/run-standalone.mjs"
    );

    let preflights = 0;
    const sidecar = http.createServer((request, response) => {
      if (request.url !== "/patty-code/internal/gateway/preflight") {
        response.writeHead(404).end();
        return;
      }
      preflights += 1;
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const codex = body.harness === "codex";
        const payload = codex
          ? {
              error: {
                type: "usage_limit_reached",
                message: "Patty Code usage limit reached",
              },
              plan_type: "enterprise",
            }
          : {
              type: "error",
              error: {
                type: "rate_limit_error",
                message: "Patty Code usage limit reached",
              },
            };
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
    });
    const sidecarPort = await listen(sidecar);
    const appPort = await freePort();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "patty-packaged-runner-"));
    let logs = "";
    const child = spawn("node", [runner], {
      cwd: standalone,
      env: {
        ...process.env,
        HOME: temp,
        DATA_DIR: path.join(temp, "data"),
        PORT: String(appPort),
        API_PORT: String(appPort),
        DASHBOARD_PORT: String(appPort),
        LIVE_WS_PORT: String(await freePort()),
        REQUIRE_API_KEY: "false",
        JWT_SECRET: "packaged-live-jwt-secret-with-at-least-32-characters",
        STORAGE_ENCRYPTION_KEY: "packaged-live-storage-secret-with-at-least-32-characters",
        API_KEY_SECRET: "packaged-live-api-key-secret-with-at-least-32-characters",
        PATTY_GATEWAY_URL: `http://127.0.0.1:${sidecarPort}`,
        PATTY_GATEWAY_TOKEN: "gateway-canary-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      logs = (logs + String(chunk)).slice(-12_000);
    });
    child.stderr?.on("data", (chunk) => {
      logs = (logs + String(chunk)).slice(-12_000);
    });

    try {
      await waitForHealth(appPort, child, () => logs);
      const codex = await fetch(`http://127.0.0.1:${appPort}/v1/responses`, {
        method: "POST",
        headers: requestHeaders("codex"),
        body: JSON.stringify({
          model: "gpt-5.3-codex",
          input: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(codex.status, 429);
      assert.match(await codex.text(), /usage_limit_reached/);

      const codexSse = await fetch(`http://127.0.0.1:${appPort}/v1/responses`, {
        method: "POST",
        headers: {
          ...requestHeaders("codex"),
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "gpt-5.3-codex",
          input: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      assert.equal(codexSse.status, 429);
      assert.match(await codexSse.text(), /usage_limit_reached/);

      const claude = await fetch(`http://127.0.0.1:${appPort}/v1/messages`, {
        method: "POST",
        headers: requestHeaders("claude"),
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(claude.status, 429);
      assert.match(await claude.text(), /rate_limit_error/);

      const messages: Array<Record<string, unknown>> = [];
      const socket = new WebSocket(`ws://127.0.0.1:${appPort}/v1/responses`, {
        headers: requestHeaders("codex"),
      });
      socket.on("message", (data) => messages.push(JSON.parse(String(data))));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.3-codex",
          input: [{ role: "user", content: "hello" }],
        })
      );
      const deadline = Date.now() + 10_000;
      while (!messages.some((message) => message.type === "response.failed")) {
        assert.ok(Date.now() < deadline, "WebSocket quota rejection timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const failure = messages.find((message) => message.type === "response.failed");
      assert.match(JSON.stringify(failure), /usage_limit_reached/);
      socket.close();
      assert.equal(preflights, 4, "every HTTP/SSE/WS request must have its own preflight");
    } finally {
      await terminate(child);
      await close(sidecar);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
);
