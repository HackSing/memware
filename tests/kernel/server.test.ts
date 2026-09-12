/**
 * Kernel HTTP surface — auth, routing, error bodies and log hygiene.
 * Covers acceptance c3 (and the startup half of c4's config rules).
 */

import { test, expect } from "bun:test";
import { KernelConfigError, loadKernelEnv, type KernelEnv } from "../../src/kernel/env";
import { createKernelHandler, startKernelServer } from "../../src/kernel/server";
import { createExtractor } from "../../src/kernel/extract";
import { createEmbedService } from "../../src/kernel/embed";
import { createSearchService } from "../../src/kernel/search";
import { extractorVersion, kernelVersion } from "../../src/kernel/version";
import { StubLLMClient, type ScriptedChatResponse } from "./stubLlm";
import packageJson from "../../package.json";

import requestFixture from "./fixtures/extractRequest.json";
import mixedOutput from "./fixtures/modelOutput.mixed.json";

const TOKEN = "kernel-test-token-0123456789";

function baseEnv(overrides: Record<string, string> = {}): KernelEnv {
  return loadKernelEnv({
    MEMWARE_KERNEL_TOKEN: TOKEN,
    MEMWARE_API_KEY: "test-api-key",
    MEMWARE_EMBEDDING_MODEL: "test-embedding",
    MEMWARE_MODEL: "test-model",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function handlerWith(chatResponses: ScriptedChatResponse[] = [], envOverrides: Partial<KernelEnv> = {}) {
  const env = { ...baseEnv(), ...envOverrides };
  const llm = new StubLLMClient({ chatResponses, embed: () => [1, 0, 0] });
  const embedService = createEmbedService({
    llm,
    model: env.embeddingModel,
    maxTexts: env.maxTexts,
    timeoutMs: env.timeoutMs,
  });
  const handler = createKernelHandler({
    env,
    extractor: createExtractor({ llm, model: env.model, timeoutMs: env.timeoutMs }),
    embedService,
    searchService: createSearchService({ embed: embedService, maxCandidates: env.maxCandidates }),
    version: { kernelVersion, extractorVersion },
  });
  return { env, llm, handler };
}

function post(path: string, body: unknown, token: string | null = TOKEN): Request {
  return new Request(`http://kernel.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(path: string, token: string | null = TOKEN): Request {
  return new Request(`http://kernel.test${path}`, {
    headers: token !== null ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Capture the per-request log line(s) emitted while `run` executes. */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await run(), lines };
  } finally {
    console.error = original;
  }
}

test("a token shorter than the minimum is refused at startup", () => {
  expect(() => loadKernelEnv({ MEMWARE_KERNEL_TOKEN: "short", MEMWARE_API_KEY: "k" } as NodeJS.ProcessEnv))
    .toThrow(KernelConfigError);
  expect(() => loadKernelEnv({ MEMWARE_API_KEY: "k" } as NodeJS.ProcessEnv)).toThrow(KernelConfigError);
  expect(() => loadKernelEnv({ MEMWARE_KERNEL_TOKEN: TOKEN } as NodeJS.ProcessEnv)).toThrow(
    KernelConfigError,
  );
});

test("a separate embedding origin without its own credential is refused", () => {
  expect(() =>
    baseEnv({
      MEMWARE_BASE_URL: "https://chat.example.com/v1",
      MEMWARE_EMBEDDING_BASE_URL: "https://vectors.example.com/v1",
    }),
  ).toThrow(KernelConfigError);

  const env = baseEnv({
    MEMWARE_BASE_URL: "https://chat.example.com/v1",
    MEMWARE_EMBEDDING_BASE_URL: "https://vectors.example.com/v1",
    MEMWARE_EMBEDDING_API_KEY: "other-key",
  });
  expect(env.embeddingUsesSeparateEndpoint).toBe(true);
});

test("request ceilings come from the environment with named defaults", () => {
  expect(baseEnv().maxTexts).toBe(256);
  expect(baseEnv().maxCandidates).toBe(2000);
  expect(baseEnv({ MEMWARE_KERNEL_MAX_CANDIDATES: "50" }).maxCandidates).toBe(50);
  expect(() => baseEnv({ MEMWARE_KERNEL_MAX_CANDIDATES: "0" })).toThrow(KernelConfigError);
});

test("the kernel environment carries no local-state fields", () => {
  const env = baseEnv({ MEMWARE_DATA_DIR: "/tmp/should-be-ignored", MEMWARE_USER_ID: "someone" });

  expect(Object.keys(env)).not.toContain("dataDir");
  expect(Object.keys(env)).not.toContain("defaultUserId");
  expect(JSON.stringify(env)).not.toContain("should-be-ignored");
});

test("the service version matches the package version", () => {
  expect(kernelVersion).toBe(packageJson.version);
});

test("requests without a valid bearer token are rejected", async () => {
  const { handler } = handlerWith();

  const requests = [
    post("/search", { query: { vector: [1, 0, 0] }, candidates: [] }, null),
    post("/search", { query: { vector: [1, 0, 0] }, candidates: [] }, "wrong-token-0123456789"),
    post("/embed", { texts: [] }, null),
    get("/v1/nope", null),
  ];
  for (const request of requests) {
    const response = await handler(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "missing or invalid bearer token" },
    });
  }
});

test("GET /health is the one endpoint probes may call without a token", async () => {
  const { handler } = handlerWith();

  const response = await handler(get("/health", null));

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.service).toBe("memware-kernel");
  // Nothing secret is exposed to an anonymous caller.
  expect(JSON.stringify(body)).not.toContain(TOKEN);
  expect(JSON.stringify(body)).not.toContain("test-api-key");

  // A wrong method on the public path is still a method error, not a leak.
  expect((await handler(post("/health", {}, null))).status).toBe(405);
});

test("GET /health reports version, extractor version and embedding config", async () => {
  const { handler } = handlerWith();

  const response = await handler(get("/health"));

  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(await response.json()).toEqual({
    ok: true,
    service: "memware-kernel",
    version: kernelVersion,
    extractorVersion,
    embeddingModel: "test-embedding",
    embeddingDim: null,
  });
});

test("wrong method is 405 and unknown path is 404", async () => {
  const { handler } = handlerWith();

  const wrongMethod = await handler(post("/health", {}));
  expect(wrongMethod.status).toBe(405);
  expect((await wrongMethod.json()).error.code).toBe("method_not_allowed");

  const unknown = await handler(get("/v1/nope"));
  expect(unknown.status).toBe(404);
  expect((await unknown.json()).error.code).toBe("not_found");
});

test("POST /extract returns the contract shape", async () => {
  const { handler } = handlerWith([JSON.stringify(mixedOutput)]);

  const response = await handler(post("/extract", requestFixture));

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.extractorVersion).toBe(extractorVersion);
  expect(body.facts.length).toBeGreaterThan(0);
  expect(body.entities.length).toBeGreaterThan(0);
});

test("POST /embed and POST /search return their contract shapes", async () => {
  const { handler } = handlerWith();

  const embed = await handler(post("/embed", { texts: ["一段文本"] }));
  expect(embed.status).toBe(200);
  expect(await embed.json()).toEqual({ model: "test-embedding", dim: 3, vectors: [[1, 0, 0]] });

  const search = await handler(
    post("/search", {
      query: { vector: [1, 0, 0] },
      candidates: [
        { id: "a", vector: [1, 0, 0] },
        { id: "b", vector: [0, 1, 0] },
      ],
      minSimilarity: 0,
      topK: 1,
    }),
  );
  expect(search.status).toBe(200);
  const searchBody = await search.json();
  expect(searchBody.results).toHaveLength(1);
  expect(searchBody.results[0].id).toBe("a");
});

test("malformed input is invalid_request (400)", async () => {
  const { handler } = handlerWith();

  const badJson = await handler(post("/extract", "{not json"));
  expect(badJson.status).toBe(400);
  expect((await badJson.json()).error).toEqual({
    code: "invalid_request",
    message: "body must be valid JSON",
  });

  const missingField = await handler(post("/extract", { conversations: [] }));
  expect(missingField.status).toBe(400);
  expect((await missingField.json()).error.code).toBe("invalid_request");

  const badSearch = await handler(post("/search", { query: {}, candidates: [] }));
  expect(badSearch.status).toBe(400);
});

test("domain errors map onto contract codes", async () => {
  const invalidOutput = handlerWith(["not json at all"]);
  const invalid = await invalidOutput.handler(post("/extract", requestFixture));
  expect(invalid.status).toBe(422);
  expect((await invalid.json()).error.code).toBe("extract_output_invalid");

  const slow = handlerWith([{ delayMs: 500 }], { timeoutMs: 10 });
  const timedOut = await slow.handler(post("/extract", requestFixture));
  expect(timedOut.status).toBe(504);
  expect((await timedOut.json()).error.code).toBe("upstream_timeout");

  const failing = handlerWith([new Error("connection reset")]);
  const failed = await failing.handler(post("/extract", requestFixture));
  expect(failed.status).toBe(502);
  expect((await failed.json()).error.code).toBe("upstream_failed");

  const small = handlerWith([], { maxTexts: 1 });
  const tooLarge = await small.handler(post("/embed", { texts: ["a", "b"] }));
  expect(tooLarge.status).toBe(413);
  expect((await tooLarge.json()).error.code).toBe("payload_too_large");

  const mismatch = await small.handler(
    post("/search", { query: { vector: [1, 0, 0] }, candidates: [{ id: "x", vector: [1, 0] }] }),
  );
  expect(mismatch.status).toBe(422);
  expect((await mismatch.json()).error.code).toBe("dimension_mismatch");

  const fewCandidates = handlerWith([], { maxCandidates: 2 });
  const tooManyCandidates = await fewCandidates.handler(
    post("/search", {
      query: { vector: [1, 0, 0] },
      candidates: [
        { id: "a", vector: [1, 0, 0] },
        { id: "b", vector: [1, 0, 0] },
        { id: "c", vector: [1, 0, 0] },
      ],
    }),
  );
  expect(tooManyCandidates.status).toBe(413);
  expect((await tooManyCandidates.json()).error).toEqual({
    code: "payload_too_large",
    message: "candidates: 3 exceeds the per-request maximum of 2",
  });
});

test("the per-request log line carries no conversation text, no token and no userId", async () => {
  const { handler } = handlerWith([JSON.stringify(mixedOutput)]);

  const { lines } = await captureLogs(() => handler(post("/extract", requestFixture)));

  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(
    /^\[memware-kernel\] POST \/extract 200 \d+ms items=3 rid=[A-Za-z0-9._-]+$/,
  );
  expect(lines[0]).not.toContain(TOKEN);
  expect(lines[0]).not.toContain("星河");
  expect(lines[0]).not.toContain("tenant-42");
});

test("a caller-supplied request id is echoed when safe, replaced when not", async () => {
  const { handler } = handlerWith();

  const safe = await handler(
    new Request("http://kernel.test/health", {
      headers: { authorization: `Bearer ${TOKEN}`, "x-request-id": "req-abc_123" },
    }),
  );
  expect(safe.headers.get("x-request-id")).toBe("req-abc_123");

  const unsafe = await handler(
    new Request("http://kernel.test/health", {
      headers: { authorization: `Bearer ${TOKEN}`, "x-request-id": "bad id with spaces" },
    }),
  );
  expect(unsafe.headers.get("x-request-id")).not.toBe("bad id with spaces");
});

test("startKernelServer serves /health over a real socket", async () => {
  const { env, handler: _handler } = handlerWith();
  const llm = new StubLLMClient({ embed: () => [1, 0, 0] });
  const embedService = createEmbedService({
    llm,
    model: env.embeddingModel,
    maxTexts: env.maxTexts,
    timeoutMs: env.timeoutMs,
  });
  const server = startKernelServer(
    { ...env, port: 0 },
    {
      extractor: createExtractor({ llm, model: env.model, timeoutMs: env.timeoutMs }),
      embedService,
      searchService: createSearchService({ embed: embedService, maxCandidates: env.maxCandidates }),
      version: { kernelVersion, extractorVersion },
    },
  );

  try {
    const response = await fetch(`http://${env.host}:${server.port}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).service).toBe("memware-kernel");

    // Probes reach /health without a credential; everything else still 401s.
    const probe = await fetch(`http://${env.host}:${server.port}/health`);
    expect(probe.status).toBe(200);

    const unauthorized = await fetch(`http://${env.host}:${server.port}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: { vector: [1, 0, 0] }, candidates: [] }),
    });
    expect(unauthorized.status).toBe(401);
  } finally {
    server.stop();
  }
});
