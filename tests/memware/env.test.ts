/**
 * memware env parsing — required key, defaults, and error paths.
 */
import { test, expect } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadEnv, MemwareConfigError, DEFAULT_USER_ID, defaultDataDir } from "../../src/memware/env";

test("loadEnv throws MemwareConfigError when MEMWARE_API_KEY is missing", () => {
  expect(() => loadEnv({})).toThrow(MemwareConfigError);
  expect(() => loadEnv({ MEMWARE_API_KEY: "   " })).toThrow(MemwareConfigError);
});

test("loadEnv reads the API key and applies memware-owned defaults", () => {
  const env = loadEnv({ MEMWARE_API_KEY: "sk-test" });
  expect(env.apiKey).toBe("sk-test");
  expect(env.dataDir).toBe(defaultDataDir());
  expect(env.dataDir).toBe(join(homedir(), ".memware"));
  expect(env.defaultUserId).toBe(DEFAULT_USER_ID);
  expect(env.debug).toBe(false);
  // Unset optional endpoints/models stay undefined (no DEFAULT_CONFIG copy).
  expect(env.baseUrl).toBeUndefined();
  expect(env.model).toBeUndefined();
  expect(env.embeddingModel).toBeUndefined();
  expect(env.embeddingDim).toBeUndefined();
});

test("loadEnv forwards optional vars and overrides", () => {
  const env = loadEnv({
    MEMWARE_API_KEY: "sk-test",
    MEMWARE_BASE_URL: "https://example.com/v1",
    MEMWARE_MODEL: "some-model",
    MEMWARE_EMBEDDING_MODEL: "embed-model",
    MEMWARE_EMBEDDING_DIM: "1024",
    MEMWARE_DATA_DIR: "/tmp/memware-data",
    MEMWARE_USER_ID: "alice",
    MEMWARE_DEBUG: "1",
  });
  expect(env.baseUrl).toBe("https://example.com/v1");
  expect(env.model).toBe("some-model");
  expect(env.embeddingModel).toBe("embed-model");
  expect(env.embeddingDim).toBe(1024);
  expect(env.dataDir).toBe("/tmp/memware-data");
  expect(env.defaultUserId).toBe("alice");
  expect(env.debug).toBe(true);
});

test("loadEnv rejects a malformed embedding dim", () => {
  expect(() => loadEnv({ MEMWARE_API_KEY: "k", MEMWARE_EMBEDDING_DIM: "not-a-number" })).toThrow(
    MemwareConfigError,
  );
  expect(() => loadEnv({ MEMWARE_API_KEY: "k", MEMWARE_EMBEDDING_DIM: "0" })).toThrow(
    MemwareConfigError,
  );
  expect(() => loadEnv({ MEMWARE_API_KEY: "k", MEMWARE_EMBEDDING_DIM: "3.5" })).toThrow(
    MemwareConfigError,
  );
});
