/**
 * Phase 4 — local HTTP API: config validation (loopback-only, token required),
 * auth enforcement, and a real Bun.serve process→resume round trip.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemwareEnv } from "../../src/memware/env";
import { MemwareConfigError } from "../../src/memware/env";
import { createHttpHandler, resolveHttpOptions, startHttpServer, type HttpServerOptions } from "../../src/memware/httpServer";
import { MemoryRegistry } from "../../src/memware/memoryRegistry";
import { buildStubMemory } from "./stubMemory";
import { initializeTenantContext, prepareTenantStorage } from "../../src/memware/tenant";
import { TenantMemoryHandle } from "../../src/memware/tenantMemoryHandle";
import { SingleTenantProvider } from "../../src/memware/tenantProvider";

const TOKEN = "test-token-0123456789";

// ── resolveHttpOptions ──

test("resolveHttpOptions defaults to loopback:18970 and requires a strong token", () => {
  const opts = resolveHttpOptions({ MEMWARE_HTTP_TOKEN: TOKEN });
  expect(opts.host).toBe("127.0.0.1");
  expect(opts.port).toBe(18970);
  expect(opts.token).toBe(TOKEN);

  expect(() => resolveHttpOptions({})).toThrow(MemwareConfigError);
  expect(() => resolveHttpOptions({ MEMWARE_HTTP_TOKEN: "short" })).toThrow(MemwareConfigError);
});

test("resolveHttpOptions refuses non-loopback hosts and bad ports", () => {
  expect(() => resolveHttpOptions({ MEMWARE_HTTP_TOKEN: TOKEN, MEMWARE_HTTP_HOST: "0.0.0.0" })).toThrow(MemwareConfigError);
  expect(() => resolveHttpOptions({ MEMWARE_HTTP_TOKEN: TOKEN, MEMWARE_HTTP_HOST: "192.168.1.5" })).toThrow(MemwareConfigError);
  expect(resolveHttpOptions({ MEMWARE_HTTP_TOKEN: TOKEN, MEMWARE_HTTP_HOST: "localhost" }).host).toBe("localhost");
  expect(resolveHttpOptions({ MEMWARE_HTTP_TOKEN: TOKEN, MEMWARE_HTTP_HOST: "[::1]" }).host).toBe("[::1]");

  expect(() => resolveHttpOptions({ MEMWARE_HTTP_TOKEN: TOKEN, MEMWARE_HTTP_PORT: "0" })).toThrow(MemwareConfigError);
  expect(() => resolveHttpOptions({ MEMWARE_HTTP_TOKEN: TOKEN, MEMWARE_HTTP_PORT: "99999" })).toThrow(MemwareConfigError);
  expect(() => resolveHttpOptions({ MEMWARE_HTTP_TOKEN: TOKEN, MEMWARE_HTTP_PORT: "abc" })).toThrow(MemwareConfigError);
});

// ── handler + real server ──

function makeEnv(dataDir: string): MemwareEnv {
  return { apiKey: "test", dataDir, defaultUserId: "default", agentId: "test-agent", debug: false };
}

function stubProvider(dataDir: string) {
  // Payload carries an active thread so the process→resume round trip has a
  // thread to surface (the topic_quote must be a substring of the user turn).
  const payload = {
    version: "v1" as const,
    event: {
      ts: "2026-09-11T12:00:00.000Z",
      summary: "thread update",
      confidence: 0.9,
      categories: ["memory"],
    },
    facts: {
      active_threads: [
        {
          topic_quote: "重构鉴权中间件",
          topic_label: "鉴权重构",
          status: "active",
          next_step: "完成 server.ts 鉴权中间件",
        },
      ],
    },
    routes: {},
  };
  const { service, state } = buildStubMemory(payload);
  const registry = new MemoryRegistry(async () => service);
  const env = makeEnv(dataDir);
  const tenant = initializeTenantContext(env.dataDir, env.defaultUserId);
  prepareTenantStorage(tenant);
  const handle = new TenantMemoryHandle(tenant, registry);
  return { provider: new SingleTenantProvider(handle), state, env };
}

const tmp = mkdtempSync(join(tmpdir(), "memware-http-"));
const servers: Array<{ stop: () => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const OPTS: HttpServerOptions = { host: "127.0.0.1", port: 0, token: TOKEN };

test("handler rejects missing and wrong bearer tokens", async () => {
  const { provider, env } = stubProvider(join(tmp, "auth"));
  const handler = createHttpHandler(env, provider, OPTS);

  const noAuth = await handler(new Request("http://127.0.0.1/health"));
  expect(noAuth.status).toBe(401);

  const wrongAuth = await handler(
    new Request("http://127.0.0.1/health", { headers: { authorization: "Bearer wrong-token-999999" } }),
  );
  expect(wrongAuth.status).toBe(401);

  const nonBearer = await handler(
    new Request("http://127.0.0.1/health", { headers: { authorization: `Basic ${TOKEN}` } }),
  );
  expect(nonBearer.status).toBe(401);
});

test("handler serves /health and validates bodies", async () => {
  const { provider, env } = stubProvider(join(tmp, "health"));
  const handler = createHttpHandler(env, provider, OPTS);
  const auth = { authorization: `Bearer ${TOKEN}` };

  const health = (await (await handler(new Request("http://127.0.0.1/health", { headers: auth }))).json()) as Record<string, unknown>;
  expect(health.ok).toBe(true);
  expect(health.server).toBe("memware");
  expect(health.agentId).toBe("test-agent");

  const badJson = await handler(new Request("http://127.0.0.1/v1/process", { method: "POST", headers: auth, body: "{oops" }));
  expect(badJson.status).toBe(400);

  const missingQuery = await handler(
    new Request("http://127.0.0.1/v1/context", { method: "POST", headers: auth, body: JSON.stringify({}) }),
  );
  expect(missingQuery.status).toBe(400);

  const notFound = await handler(new Request("http://127.0.0.1/v1/nope", { method: "POST", headers: auth, body: "{}" }));
  expect(notFound.status).toBe(404);
});

test("real server: process then resume over HTTP", async () => {
  const { provider, env } = stubProvider(join(tmp, "roundtrip"));
  const running = await startHttpServer(env, provider, OPTS);
  servers.push(running);
  const base = `http://127.0.0.1:${running.port}`;
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  const processRes = await fetch(`${base}/v1/process`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      sessionId: "http-sess-1",
      userMessage: "我们要开始重构鉴权中间件",
      assistantMessage: "好的,先从 server.ts 开始。",
      agentId: "codex",
    }),
  });
  expect(processRes.status).toBe(200);
  const processBody = (await processRes.json()) as Record<string, unknown>;
  expect(processBody.ok).toBe(true);

  const resumeRes = await fetch(`${base}/v1/resume`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ topic: "鉴权" }),
  });
  expect(resumeRes.status).toBe(200);
  const resumeBody = (await resumeRes.json()) as { threads: Array<Record<string, unknown>>; brief: string };
  expect(resumeBody.threads.length).toBeGreaterThanOrEqual(1);
  expect(resumeBody.threads[0]!.last_agent_id).toBe("codex");
  expect(resumeBody.brief).toContain("last agent: codex");

  // Stop even a concurrently-failing run: ensure stop is callable.
  running.stop();
});
