/**
 * memware hook mode — extract the final turn from a transcript and write it via
 * the same path as memory_process; never block the host on failure.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemwareEnv } from "../../src/memware/env";
import { MemoryRegistry } from "../../src/memware/memoryRegistry";
import { runHook } from "../../src/memware/hook";
import { DEFAULT_CONFIG } from "../../src/agent/memory/config";
import { buildStubMemory, DEFAULT_EVIDENCE, type StubState } from "./stubMemory";

const tmp = mkdtempSync(join(tmpdir(), "memware-hook-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function makeEnv(): MemwareEnv {
  return { apiKey: "test", dataDir: tmp, defaultUserId: "default", debug: false };
}

function stubRegistry(): { registry: MemoryRegistry; state: StubState } {
  const { service, state } = buildStubMemory();
  return { registry: new MemoryRegistry(async () => service), state };
}

function writeTranscript(name: string, lines: unknown[]): string {
  const path = join(tmp, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return path;
}

test("runHook writes the last turn through the shared pipeline", async () => {
  const transcriptPath = writeTranscript("t1.jsonl", [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    { type: "user", message: { role: "user", content: `我${DEFAULT_EVIDENCE}` } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "记住了" }] } },
  ]);
  const { registry, state } = stubRegistry();
  const stdin = JSON.stringify({ session_id: "sess-1", transcript_path: transcriptPath });

  const result = await runHook(makeEnv(), registry, stdin);

  expect(result.wrote).toBe(true);
  expect(state.warmupCalls).toContain("default");
  expect(state.chatCompletionCalls).toBe(1);
  expect(state.addClusterCalls.length).toBeGreaterThanOrEqual(1);
  expect(state.addClusterCalls[0]!.cluster.fact).toBe("用户最喜欢的颜色是蓝色");
});

test("runHook does not block on a missing transcript", async () => {
  const { registry, state } = stubRegistry();
  const stdin = JSON.stringify({ session_id: "s", transcript_path: join(tmp, "nope.jsonl") });
  const result = await runHook(makeEnv(), registry, stdin);
  expect(result.wrote).toBe(false);
  expect(result.reason).toBe("transcript-unreadable");
  expect(state.addClusterCalls.length).toBe(0);
});

test("runHook does not block on corrupt hook JSON", async () => {
  const { registry } = stubRegistry();
  const result = await runHook(makeEnv(), registry, "{ not valid json");
  expect(result.wrote).toBe(false);
  expect(result.reason).toBe("hook-json-parse");
});

test("runHook skips a transcript with no user turn", async () => {
  const transcriptPath = writeTranscript("t2.jsonl", [
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "orphan" }] } },
  ]);
  const { registry, state } = stubRegistry();
  const stdin = JSON.stringify({ session_id: "s", transcript_path: transcriptPath });
  const result = await runHook(makeEnv(), registry, stdin);
  expect(result.wrote).toBe(false);
  expect(result.reason).toBe("no-user-turn");
  expect(state.warmupCalls.length).toBe(0);
});

test("runHook without MEMWARE_MODEL resolves the kernel default extractor model", async () => {
  // Regression for the c6 field failure: env.model unset used to fall through
  // to the kernel runner's "unknown" placeholder, which the provider rejects
  // with HTTP 400 and the hook silently skipped the write.
  const transcriptPath = writeTranscript("t3.jsonl", [
    { type: "user", message: { role: "user", content: `我${DEFAULT_EVIDENCE}` } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "记住了" }] } },
  ]);
  const { registry, state } = stubRegistry();
  const stdin = JSON.stringify({ session_id: "sess-1", transcript_path: transcriptPath });

  const env = makeEnv(); // no `model` field — the new-user default
  expect(env.model).toBeUndefined();
  const result = await runHook(env, registry, stdin);

  expect(result.wrote).toBe(true);
  expect(state.chatCompletionModels).toEqual([DEFAULT_CONFIG.model.model_name]);
});
