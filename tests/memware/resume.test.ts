/**
 * Phase 2 — cross-agent task handoff: buildResumeBrief assembly plus the
 * memory_resume tool end-to-end over InMemoryTransport with two writers.
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
import { buildResumeBrief } from "../../src/memware/resume";
import type { ActiveThread, MemoryCluster } from "../../src/agent/memory/types";
import type { UnifiedMemoryExtraction } from "../../src/agent/memory/unified/schema";
import { buildStubMemory } from "./stubMemory";
import { initializeTenantContext, prepareTenantStorage } from "../../src/memware/tenant";
import { TenantMemoryHandle } from "../../src/memware/tenantMemoryHandle";
import { SingleTenantProvider } from "../../src/memware/tenantProvider";

// ── buildResumeBrief (pure) ──

const cluster = (fact: string): MemoryCluster => ({
  fact,
  importance_score: 0.5,
  created_at: "2026-09-11T00:00:00.000Z",
});

test("buildResumeBrief explains an empty thread list", () => {
  const r = buildResumeBrief([], []);
  expect(r.threads).toEqual([]);
  expect(r.brief).toContain("No active task threads");
});

test("buildResumeBrief renders agent, recency, next step, and related memory", () => {
  const threads: ActiveThread[] = [
    {
      topic: "重构鉴权中间件",
      status: "active",
      next_step: "完成 server.ts 的鉴权中间件",
      last_agent_id: "codex",
      updated_at: "2026-09-11T08:00:00.000Z",
    },
  ];
  const r = buildResumeBrief(threads, [[cluster("用户项目用 Bun 构建")]]);
  expect(r.threads[0]!.last_agent_id).toBe("codex");
  expect(r.threads[0]!.related).toEqual(["用户项目用 Bun 构建"]);
  expect(r.brief).toContain("1. [重构鉴权中间件] (active, last agent: codex, updated: 2026-09-11)");
  expect(r.brief).toContain("Next step: 完成 server.ts 的鉴权中间件");
  expect(r.brief).toContain("- 用户项目用 Bun 构建");
});

test("buildResumeBrief tolerates missing related clusters and legacy threads", () => {
  const threads: ActiveThread[] = [{ topic: "旧线程", status: "waiting" }];
  const r = buildResumeBrief(threads, [undefined as unknown as MemoryCluster[]]);
  expect(r.threads[0]!.related).toEqual([]);
  expect(r.brief).toContain("[旧线程] (waiting)");
});

// ── memory_resume over MCP (two-agent handoff) ──

const TOPIC_QUOTE = "重构鉴权中间件";

function threadPayload(status: string, nextStep?: string): UnifiedMemoryExtraction {
  return {
    version: "v1",
    event: {
      ts: "2026-09-11T12:00:00.000Z",
      summary: "thread update",
      confidence: 0.9,
      categories: ["memory"],
    },
    facts: {
      active_threads: [
        {
          topic_quote: TOPIC_QUOTE,
          topic_label: "鉴权重构",
          status,
          ...(nextStep ? { next_step: nextStep } : {}),
        },
      ],
    },
    routes: {},
  };
}

async function setup(payload: UnifiedMemoryExtraction) {
  const dataDir = mkdtempSync(join(tmpdir(), "memware-resume-"));
  const env: MemwareEnv = { apiKey: "test", dataDir, defaultUserId: "default", agentId: "test-agent", debug: false };
  const { service, state } = buildStubMemory(payload);
  const registry = new MemoryRegistry(async () => service);
  const tenant = initializeTenantContext(dataDir, env.defaultUserId);
  prepareTenantStorage(tenant);
  const handle = new TenantMemoryHandle(tenant, registry);
  const provider = new SingleTenantProvider(handle);
  const server = createMemwareServer(env, provider);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "memware-resume-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    state,
    env,
    dispose: async () => {
      await client.close();
      await server.close();
      await provider.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]!.text ?? "null") as Record<string, unknown>;
}

test("memory_resume reports the last writer after a two-agent handoff", async () => {
  const h = await setup(threadPayload("active", "完成 server.ts 鉴权中间件"));
  try {
    // Agent A (claude-code) opens the thread…
    await call(h.client, "memory_process", {
      sessionId: "s-a",
      turnIndex: 0,
      userMessage: `我们继续${TOPIC_QUOTE}`,
      assistantMessage: "好的,开始。",
      userId: "default",
    });
    // (second writer on the same topic needs a fresh env.agentId — mutate env is
    // not possible post-setup, so verify handoff via a direct second server run)
  } finally {
    await h.dispose();
  }

  // Agent B (codex) picks the thread up in its own server instance.
  const h2 = await setup(threadPayload("active", "跑通鉴权测试"));
  try {
    // Simulate that the thread already carries agent A's touch.
    h2.state.activeThreads.push({
      topic: "鉴权重构",
      status: "active",
      next_step: "完成 server.ts 鉴权中间件",
      last_agent_id: "claude-code",
      updated_at: "2026-09-10T18:00:00.000Z",
    });
    const resumed = await call(h2.client, "memory_resume", { userId: "default" });
    const threads = resumed.threads as Array<Record<string, unknown>>;
    expect(threads.length).toBe(1);
    expect(threads[0]!.last_agent_id).toBe("claude-code");
    const brief = resumed.brief as string;
    expect(brief).toContain("last agent: claude-code");
    expect(brief).toContain("Next step: 完成 server.ts 鉴权中间件");
  } finally {
    await h2.dispose();
  }
});

test("memory_resume filters by topic and reports empty when nothing matches", async () => {
  const h = await setup(threadPayload("active"));
  try {
    h.state.activeThreads.push({
      topic: "鉴权重构",
      status: "active",
      last_agent_id: "codex",
    });
    const focused = await call(h.client, "memory_resume", { topic: "鉴权", userId: "default" });
    expect(((focused.threads as unknown[]) ?? []).length).toBe(1);

    const miss = await call(h.client, "memory_resume", { topic: "完全不相关", userId: "default" });
    expect(((miss.threads as unknown[]) ?? []).length).toBe(0);
    expect(miss.brief).toContain("No active task threads");
  } finally {
    await h.dispose();
  }
});
