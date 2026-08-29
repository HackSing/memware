/**
 * memware serve — protocol-level coverage over InMemoryTransport.
 *
 * Spins up the real McpServer + a Client on a linked in-memory pair, backed by
 * a stub memory service (fake LLM client). Covers all seven tools' happy paths
 * plus two error paths: invalid args rejected by zod, and a tool whose
 * underlying pipeline degrades gracefully.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemwareEnv } from "../../src/memware/env";
import { MemoryRegistry } from "../../src/memware/memoryRegistry";
import { createMemwareServer } from "../../src/memware/server";
import { buildStubMemory, DEFAULT_EVIDENCE, type StubState } from "./stubMemory";
import { initializeTenantContext, prepareTenantStorage, type TenantContext } from "../../src/memware/tenant";
import { TenantMemoryHandle } from "../../src/memware/tenantMemoryHandle";
import { SingleTenantProvider } from "../../src/memware/tenantProvider";

interface Harness {
  client: Client;
  state: StubState;
  tenant: TenantContext;
  dispose: () => Promise<void>;
}

async function setup(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "memware-serve-"));
  const env: MemwareEnv = { apiKey: "test", dataDir, defaultUserId: "default", debug: false };
  const { service, state } = buildStubMemory();
  const registry = new MemoryRegistry(async () => service);
  const tenant = initializeTenantContext(dataDir, env.defaultUserId);
  prepareTenantStorage(tenant);
  const handle = new TenantMemoryHandle(tenant, registry);
  const provider = new SingleTenantProvider(handle);
  const server = createMemwareServer(env, provider);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "memware-test", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    state,
    tenant,
    dispose: async () => {
      await client.close();
      await server.close();
      await provider.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]!.text ?? "null");
}

test("lists all seven memory tools", async () => {
  const h = await setup();
  try {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "memory_archive",
        "memory_get_context",
        "memory_process",
        "memory_reset",
        "memory_search",
        "memory_status",
        "memory_warmup",
      ].sort(),
    );
  } finally {
    await h.dispose();
  }
});

test("memory_status reports storage + runtime", async () => {
  const h = await setup();
  try {
    const status = (await call(h.client, "memory_status")) as Record<string, any>;
    expect(status.server).toBe("memware");
    expect(status.tenantBoundary).toBe("single-process-v1");
    expect(status.storageLayoutVersion).toBe("t1");
    expect(status.permissionsSecure).toBe(true);
    expect(status.defaultUserId).toBeUndefined();
    expect(status.storage).toBeUndefined();
    expect(status.modelConfiguration).toEqual({
      source: "builtin-default",
      projectConfigDiscovery: false,
      chatEndpointOrigin: "https://api.siliconflow.cn",
      embeddingEndpointOrigin: "https://api.siliconflow.cn",
      embeddingUsesSeparateCredential: false,
    });
    expect(status.runtime.persistent).toBe(true);
  } finally {
    await h.dispose();
  }
});

test("memory_warmup binds the configured tenant and rejects a foreign one", async () => {
  const h = await setup();
  try {
    const a = (await call(h.client, "memory_warmup")) as Record<string, unknown>;
    expect(a.userId).toBe("default");
    await call(h.client, "memory_warmup", { userId: "default" });
    let rejected = false;
    try {
      const result = (await h.client.callTool({
        name: "memory_warmup",
        arguments: { userId: "bob" },
      })) as { isError?: boolean };
      rejected = result.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(h.state.warmupCalls).toEqual(["default", "default"]);
  } finally {
    await h.dispose();
  }
});

test("every business tool rejects a caller-selected foreign tenant", async () => {
  const h = await setup();
  try {
    const calls = [
      { name: "memory_warmup", arguments: { userId: "foreign" } },
      { name: "memory_get_context", arguments: { userId: "foreign", query: "q" } },
      {
        name: "memory_process",
        arguments: {
          userId: "foreign",
          sessionId: "s",
          turnIndex: 0,
          userMessage: "u",
          assistantMessage: "a",
        },
      },
      { name: "memory_search", arguments: { userId: "foreign", query: "q" } },
      { name: "memory_archive", arguments: { userId: "foreign" } },
      { name: "memory_reset", arguments: { userId: "foreign" } },
    ];
    for (const input of calls) {
      let rejected = false;
      try {
        const result = (await h.client.callTool(input)) as { isError?: boolean };
        rejected = result.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
    expect(h.state.warmupCalls).toEqual([]);
    expect(h.state.getContextCalls).toEqual([]);
    expect(h.state.searchCalls).toEqual([]);
    expect(h.state.archiveCalls).toEqual([]);
    expect(h.state.resetCalls).toEqual([]);
    expect(h.state.chatCompletionCalls).toBe(0);
  } finally {
    await h.dispose();
  }
});

test("memory_get_context returns system + context text", async () => {
  const h = await setup();
  try {
    const ctx = (await call(h.client, "memory_get_context", { query: "颜色" })) as Record<string, unknown>;
    expect(ctx).toEqual({ system: "SYS", context: "CTX for 颜色" });
    expect(h.state.getContextCalls[0]).toEqual({ userId: "default", query: "颜色" });
  } finally {
    await h.dispose();
  }
});

test("memory_process runs the extractor and writes a cluster", async () => {
  const h = await setup();
  try {
    const res = (await call(h.client, "memory_process", {
      sessionId: "s1",
      turnIndex: 0,
      userMessage: `我${DEFAULT_EVIDENCE}`,
      assistantMessage: "记住了",
    })) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.actions as number).toBeGreaterThanOrEqual(1);
    expect(h.state.chatCompletionCalls).toBe(1);
    expect(h.state.addClusterCalls.length).toBeGreaterThanOrEqual(1);
  } finally {
    await h.dispose();
  }
});

test("memory_search returns results + clusters", async () => {
  const h = await setup();
  try {
    const out = (await call(h.client, "memory_search", { query: "蓝色", limit: 3 })) as Record<string, any>;
    expect(out.results).toBe("results for 蓝色");
    expect(Array.isArray(out.clusters)).toBe(true);
    expect(h.state.searchCalls[0]).toEqual({ userId: "default", query: "蓝色", limit: 3 });
  } finally {
    await h.dispose();
  }
});

test("memory_archive uses the bound tenant and memory_reset deletes the tenant root", async () => {
  const h = await setup();
  try {
    await call(h.client, "memory_archive", { userId: "default" });
    const reset = (await call(h.client, "memory_reset", { userId: "default" })) as Record<string, unknown>;
    expect(h.state.archiveCalls).toContain("default");
    expect(h.state.resetCalls).toEqual([]);
    expect(reset.ok).toBe(true);
    expect(reset.status).toBe("deleted");
    expect(reset.userId).toBe("default");
  } finally {
    await h.dispose();
  }
});

test("error path: invalid args are rejected by zod validation", async () => {
  const h = await setup();
  try {
    // memory_process requires sessionId/turnIndex/userMessage/assistantMessage.
    // The SDK validates inputSchema at the boundary and surfaces a failure as
    // an isError result (or a rejection) — either way the handler never runs.
    let errored = false;
    try {
      const result = (await h.client.callTool({
        name: "memory_process",
        arguments: { userMessage: "x" },
      })) as { isError?: boolean };
      errored = result.isError === true;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
    // no write happened
    expect(h.state.addClusterCalls.length).toBe(0);
  } finally {
    await h.dispose();
  }
});

test("error path: extractor no-op when the LLM returns garbage", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memware-serve-bad-"));
  const env: MemwareEnv = { apiKey: "test", dataDir, defaultUserId: "default", debug: false };
  // Stub whose LLM returns non-JSON — extractor fails, process returns ok:false.
  const { service, state } = buildStubMemory();
  (service as { getLLMClient: () => unknown }).getLLMClient = () => ({
    async chatCompletion() {
      state.chatCompletionCalls += 1;
      return { content: "not json at all" };
    },
    async embed() {
      return { embeddings: [[0, 0]] };
    },
  });
  const registry = new MemoryRegistry(async () => service);
  const tenant = initializeTenantContext(dataDir, env.defaultUserId);
  prepareTenantStorage(tenant);
  const handle = new TenantMemoryHandle(tenant, registry);
  const provider = new SingleTenantProvider(handle);
  const server = createMemwareServer(env, provider);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  try {
    const res = (await call(client, "memory_process", {
      sessionId: "s",
      turnIndex: 0,
      userMessage: "hi",
      assistantMessage: "yo",
    })) as Record<string, unknown>;
    expect(res.ok).toBe(false);
    expect(res.actions).toBe(0);
    expect(state.addClusterCalls.length).toBe(0);
  } finally {
    await client.close();
    await server.close();
    await provider.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
