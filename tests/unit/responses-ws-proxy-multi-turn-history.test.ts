// Regression test for issue #7388: Responses WebSocket history/usage logging
// was scoped to `ResponsesWsSession.historyLogged` — a single boolean per
// WebSocket CONNECTION — instead of per logical `response.create` turn. When
// a Codex client reuses one WebSocket connection for two sequential turns,
// only the first terminal event (`response.completed`) was persisted to
// `call_logs`; the second turn's usage/history was silently dropped.
//
// This test opens ONE WebSocket connection, sends two `response.create`
// messages sequentially, and has the fake upstream emit two distinct
// `response.completed` events (different `response.id`, different usage).
// EXPECTED (post-fix): two "log" internal requests, one per turn, each
// carrying its own terminal response id and its own request body.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { createResponsesWsProxy } = await import("../../scripts/dev/responses-ws-proxy.mjs");

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve((address as { port: number }).port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function waitFor<T>(
  predicate: () => T | undefined | null | false,
  { timeoutMs = 3000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const value = predicate();
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for condition"));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, intervalMs);
  });
}

test("#7388: a reused Responses WebSocket connection logs both of two logical turns", async () => {
  const internalRequests: Array<Record<string, unknown>> = [];
  const downstreamMessages: Array<Record<string, unknown>> = [];
  const upstreamSends: Array<Record<string, unknown>> = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/internal/codex-responses-ws") {
      const body = JSON.parse((await readRequestBody(req)) || "{}");
      internalRequests.push(body);

      if (body.action === "authenticate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, authenticated: true, authType: "api_key" }));
        return;
      }

      if (body.action === "prepare") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            upstreamUrl: "wss://chatgpt.com/backend-api/codex/responses",
            headers: { Authorization: "Bearer upstream-token" },
            connectionId: "conn_1",
            provider: "codex",
            account: "codex@example.com",
            model: "gpt-5.4-mini",
            response: { ...body.response, model: "gpt-5.4-mini", stream: undefined },
          })
        );
        return;
      }

      if (body.action === "log") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, logged: true }));
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  // Fake upstream: reply to whichever turn was just sent with a distinct
  // response.completed event (distinct response.id + usage), matching the
  // issue's minimal reproduction of two sequential turns on one socket.
  let turn = 0;
  const fakeUpstream = {
    send(data: string) {
      const parsed = JSON.parse(data);
      upstreamSends.push(parsed);
      if (parsed.type !== "response.create") return;
      turn += 1;
      const currentTurn = turn;
      setTimeout(() => {
        fakeUpstream.onmessage?.({
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_${currentTurn}`,
              model: "gpt-5.4-mini",
              status: "completed",
              usage: {
                input_tokens: 10 * currentTurn,
                output_tokens: 20 * currentTurn,
                total_tokens: 30 * currentTurn,
              },
            },
          }),
        });
      }, 10);
    },
    close() {},
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null,
    onclose: null,
  };

  const port = await listen(server);
  const proxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1000,
    idleTimeoutMs: 10000,
    wsFactory: async () => fakeUpstream,
  });

  server.on("upgrade", async (req, socket, head) => {
    const handled = await proxy.handleUpgrade(req, socket, head);
    if (!handled && !socket.destroyed) {
      socket.destroy();
    }
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/responses?api_key=local-token`);
  ws.addEventListener("message", (event) => {
    downstreamMessages.push(JSON.parse(String(event.data)));
  });

  try {
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

    // Turn 1 on this single, reused WebSocket connection.
    ws.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4-mini",
        input: [{ role: "user", content: "Reply with exactly: pong1" }],
        stream: true,
      })
    );

    await waitFor(
      () => downstreamMessages.filter((entry) => entry.type === "response.completed").length === 1
    );

    // Turn 2 on the SAME WebSocket connection (client reuse), per the issue's
    // repro: "Codex clients may reuse one WebSocket connection for multiple
    // logical turns."
    ws.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4-mini",
        input: [{ role: "user", content: "Reply with exactly: pong2" }],
        stream: true,
      })
    );

    await waitFor(
      () => downstreamMessages.filter((entry) => entry.type === "response.completed").length === 2
    );

    // Both logical turns completed downstream — confirms the repro precondition
    // from the issue ("The WebSocket received two terminal events").
    assert.equal(upstreamSends.filter((entry) => entry.type === "response.create").length, 2);
    assert.equal(
      downstreamMessages.filter((entry) => entry.type === "response.completed").length,
      2
    );

    // Give any async persistHistory() calls a moment to land, then assert on
    // the internal "log" calls actually issued to the bridge.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const logRequests = internalRequests.filter((entry) => entry.action === "log");

    // One call-log row per logical turn (2) — the second turn must not be
    // dropped by a session-level "already logged" guard (#7388).
    assert.equal(
      logRequests.length,
      2,
      `expected 2 call-log entries (one per logical turn), got ${logRequests.length} — ` +
        "second turn's history/usage was dropped by the session-level historyLogged guard (#7388)"
    );

    const respIds = logRequests
      .map(
        (entry) => (entry.terminalMessage as { response?: { id?: string } } | null)?.response?.id
      )
      .sort();
    assert.deepEqual(
      respIds,
      ["resp_1", "resp_2"],
      "each logged call should carry its own terminal response.id, not just the first turn's"
    );

    // Each logged call's clientRequest must reflect the request body of the
    // turn actually being finalized, not always turn 1's body (#7388).
    const contentByTurn = logRequests
      .map((entry) => {
        const clientRequest = entry.clientRequest as {
          input?: Array<{ content?: string }>;
        } | null;
        return clientRequest?.input?.[0]?.content;
      })
      .sort();
    assert.deepEqual(
      contentByTurn,
      ["Reply with exactly: pong1", "Reply with exactly: pong2"],
      "each logged call's clientRequest should carry its own turn's request body"
    );
  } finally {
    ws.close();
    await close(server);
  }
});

test("Patty reauthorizes and settles every turn before Enterprise limits and completion", async () => {
  const internalRequests: Array<Record<string, unknown>> = [];
  const downstreamMessages: Array<Record<string, unknown>> = [];
  const upstreamSends: Array<Record<string, unknown>> = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname !== "/api/internal/codex-responses-ws") {
      res.writeHead(404).end();
      return;
    }

    const body = JSON.parse((await readRequestBody(req)) || "{}") as Record<string, unknown>;
    internalRequests.push(body);
    if (body.action === "authenticate") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, authenticated: true, authType: "api_key" }));
      return;
    }
    if (body.action === "prepare") {
      const response = body.response as Record<string, unknown>;
      const turnId = String(body.turnId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          upstreamUrl: "wss://chatgpt.com/backend-api/codex/responses",
          headers: { Authorization: "Bearer upstream-token" },
          connectionId: "conn-patty",
          provider: "codex",
          account: "employee@example.com",
          model: "gpt-5.5-upstream",
          response: { ...response, model: "gpt-5.5-upstream", stream: undefined },
          pattyDecision: {
            preflightRef: `pf-${turnId}`,
            requestId: body.requestId,
            turnId,
            harness: "codex",
            publicModel: response.model,
            routedModel: "codex/gpt-5.5-upstream",
            quota: {
              fiveHour: { spend: 10, limit: 100, usedPercent: 10, resetAt: 1_800_000_000 },
              sevenDay: { spend: 20, limit: 100, usedPercent: 20, resetAt: 1_800_100_000 },
            },
          },
        })
      );
      return;
    }
    if (body.action === "settle") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          settled: true,
          rateLimits: {
            type: "codex.rate_limits",
            plan_type: "enterprise",
            rate_limits: {
              allowed: true,
              limit_reached: false,
              primary: { used_percent: 10, window_minutes: 300, reset_at: 1_800_000_000 },
              secondary: {
                used_percent: 20,
                window_minutes: 10080,
                reset_at: 1_800_100_000,
              },
            },
            code_review_rate_limits: null,
            credits: null,
            promo: null,
          },
        })
      );
      return;
    }
    if (body.action === "log") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, logged: true }));
      return;
    }
    res.writeHead(400).end();
  });

  let upstreamTurn = 0;
  const fakeUpstream = {
    send(data: string) {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      upstreamSends.push(parsed);
      upstreamTurn += 1;
      const responseId = `patty_resp_${upstreamTurn}`;
      setTimeout(() => {
        fakeUpstream.onmessage?.({
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id: responseId,
              model: "gpt-5.5-upstream",
              status: "completed",
              usage: { input_tokens: upstreamTurn, output_tokens: upstreamTurn + 1 },
            },
          }),
        });
      }, 5);
    },
    close() {},
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null,
    onclose: null,
  };

  const port = await listen(server);
  const proxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1_000,
    idleTimeoutMs: 10_000,
    wsFactory: async () => fakeUpstream,
  });
  server.on("upgrade", async (req, socket, head) => {
    const handled = await proxy.handleUpgrade(req, socket, head);
    if (!handled && !socket.destroyed) socket.destroy();
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/responses?api_key=local-token`);
  ws.addEventListener("message", (event) => {
    downstreamMessages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });

  try {
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    for (const prompt of ["first", "second"]) {
      ws.send(
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.3-codex",
          input: [{ role: "user", content: prompt }],
        })
      );
      const expected = prompt === "first" ? 1 : 2;
      await waitFor(
        () =>
          downstreamMessages.filter((entry) => entry.type === "response.completed").length ===
          expected
      );
    }

    const prepareCalls = internalRequests.filter((entry) => entry.action === "prepare");
    const settleCalls = internalRequests.filter((entry) => entry.action === "settle");
    assert.equal(prepareCalls.length, 2, "each response.create reauthorizes");
    assert.deepEqual(
      prepareCalls.map((entry) => entry.turnId),
      ["turn-1", "turn-2"]
    );
    assert.equal(new Set(prepareCalls.map((entry) => entry.requestId)).size, 1);
    assert.equal(settleCalls.length, 2, "each terminal event settles once");
    assert.deepEqual(
      settleCalls.map((entry) => (entry.decision as { turnId: string }).turnId),
      ["turn-1", "turn-2"]
    );
    assert.equal(
      upstreamSends.every((entry) => entry.model === "gpt-5.5-upstream"),
      true
    );
    assert.equal(
      upstreamSends.some((entry) => "authorization" in entry || "credential" in entry),
      false
    );

    const terminalIndexes = downstreamMessages.flatMap((entry, index) =>
      entry.type === "response.completed" ? [index] : []
    );
    assert.equal(terminalIndexes.length, 2);
    for (const terminalIndex of terminalIndexes) {
      const rateLimits = downstreamMessages[terminalIndex - 1];
      assert.equal(rateLimits.type, "codex.rate_limits");
      assert.equal(rateLimits.plan_type, "enterprise");
      assert.equal(
        (rateLimits.rate_limits as { primary: { window_minutes: number } }).primary.window_minutes,
        300
      );
      assert.equal(
        (downstreamMessages[terminalIndex].response as { model: string }).model,
        "gpt-5.3-codex"
      );
    }
  } finally {
    ws.close();
    await close(server);
  }
});
