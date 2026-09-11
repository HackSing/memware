/**
 * Phase 1 — agent provenance: MEMWARE_AGENT_ID flows from env through
 * processTurn into router-produced provenance and memory_status output.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemwareEnv } from "../../src/memware/env";
import { loadEnv } from "../../src/memware/env";
import { processTurn } from "../../src/memware/processTurn";
import { buildExtractionConfig } from "../../src/memware/processTurn";
import { buildStubMemory, DEFAULT_EVIDENCE } from "./stubMemory";
import { makeProvenance } from "../../src/agent/memory/provenance";

const tmp = mkdtempSync(join(tmpdir(), "memware-provenance-"));
rmSync(tmp, { recursive: true, force: true });

function makeEnv(overrides: Partial<MemwareEnv> = {}): MemwareEnv {
  return { apiKey: "test", dataDir: tmp, defaultUserId: "default", agentId: "claude-code", debug: false, ...overrides };
}

test("makeProvenance carries agent_id when provided and omits it otherwise", () => {
  const withAgent = makeProvenance({ sessionId: "s1", turnIndex: 0, confidence: 0.9, agentId: "codex" });
  expect(withAgent.agent_id).toBe("codex");

  const withoutAgent = makeProvenance({ sessionId: "s1", turnIndex: 0, confidence: 0.9 });
  expect("agent_id" in withoutAgent).toBe(false);
});

test("processTurn stamps agentId into the routed cluster provenance", async () => {
  const { service, state } = buildStubMemory();
  await processTurn({
    memory: service,
    config: buildExtractionConfig(makeEnv()),
    auditDir: tmp,
    userId: "default",
    sessionId: "sess-42",
    turnIndex: 0,
    userMessage: `我${DEFAULT_EVIDENCE}`,
    assistantMessage: "记住了",
    agentId: "codex",
  });

  expect(state.addClusterCalls.length).toBeGreaterThanOrEqual(1);
  const prov = state.addClusterCalls[0]!.cluster.provenance as Record<string, unknown>;
  expect(prov.agent_id).toBe("codex");
  expect(prov.session_id).toBe("sess-42");
});

test("processTurn omits agent_id when no agentId is passed (backward compat)", async () => {
  const { service, state } = buildStubMemory();
  await processTurn({
    memory: service,
    config: buildExtractionConfig(makeEnv()),
    auditDir: tmp,
    userId: "default",
    sessionId: "sess-43",
    turnIndex: 0,
    userMessage: `我${DEFAULT_EVIDENCE}`,
    assistantMessage: "记住了",
  });

  const prov = state.addClusterCalls[0]!.cluster.provenance as Record<string, unknown>;
  expect("agent_id" in prov).toBe(false);
});

test("loadEnv defaults MEMWARE_AGENT_ID to unknown and validates format", () => {
  const base = { MEMWARE_API_KEY: "sk-test" };
  expect(loadEnv(base).agentId).toBe("unknown");
  expect(loadEnv({ ...base, MEMWARE_AGENT_ID: "claude-code" }).agentId).toBe("claude-code");
  expect(loadEnv({ ...base, MEMWARE_AGENT_ID: "codex.v2_beta" }).agentId).toBe("codex.v2_beta");

  expect(() => loadEnv({ ...base, MEMWARE_AGENT_ID: "bad agent" })).toThrow();
  expect(() => loadEnv({ ...base, MEMWARE_AGENT_ID: "../etc" })).toThrow();
  expect(() => loadEnv({ ...base, MEMWARE_AGENT_ID: "x".repeat(65) })).toThrow();
});
