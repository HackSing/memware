/**
 * memware kernel — environment configuration (stateless service).
 *
 * The kernel is deployed as a container next to the backend and holds no local
 * state, so it reads ONLY model/transport variables: never MEMWARE_DATA_DIR,
 * MEMWARE_USER_ID or MEMWARE_AGENT_ID (those are local-product identity, and
 * the kernel must not be able to touch a user's on-disk memory).
 *
 * Endpoint validation and the cross-origin credential rule mirror
 * src/memware/env.ts (`validateEndpoint` / `resolveModelRuntimeConfig`). They
 * are re-stated here rather than imported because the kernel's dependency
 * boundary forbids importing src/memware/* (see tests/kernel/isolation.test.ts)
 * and src/memware/env.ts requires local-state fields the kernel does not have.
 * Keep the two rule sets in sync; both are covered by tests.
 */

import { DEFAULT_CONFIG } from "../agent/memory/config";

/** Thrown when the environment is missing or malformed. Startup must fail. */
export class KernelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelConfigError";
  }
}

// ── Defaults (single source of truth for kernel-owned values) ──

/** Loopback by default; containers set MEMWARE_KERNEL_HOST=0.0.0.0 explicitly. */
export const KERNEL_DEFAULT_HOST = "127.0.0.1";
export const KERNEL_DEFAULT_PORT = 18971;
/** Minimum Bearer token length accepted at startup. */
export const KERNEL_MIN_TOKEN_LENGTH = 16;
/** Maximum texts accepted by POST /embed in one request. */
export const KERNEL_DEFAULT_MAX_TEXTS = 256;
/** Maximum candidate vectors accepted by POST /search in one request. */
export const KERNEL_DEFAULT_MAX_CANDIDATES = 2000;
/** Upstream model call budget in milliseconds. */
export const KERNEL_DEFAULT_TIMEOUT_MS = 30000;

/** Resolved kernel environment. Every field is validated before startup. */
export interface KernelEnv {
  /** MEMWARE_API_KEY — required, OpenAI-compatible key for chat (+ embeddings). */
  apiKey: string;
  /** MEMWARE_BASE_URL — chat endpoint. */
  baseUrl: string;
  /** MEMWARE_MODEL — extraction model name. */
  model: string;
  /** MEMWARE_EMBEDDING_MODEL — embedding model name. */
  embeddingModel: string;
  /** MEMWARE_EMBEDDING_DIM — declared vector dimension; unset = derive from output. */
  embeddingDim?: number;
  /** MEMWARE_EMBEDDING_BASE_URL — embedding endpoint (defaults to baseUrl). */
  embeddingBaseUrl: string;
  /** MEMWARE_EMBEDDING_API_KEY — credential for the embedding endpoint. */
  embeddingApiKey: string;
  /** MEMWARE_KERNEL_HOST — bind address. */
  host: string;
  /** MEMWARE_KERNEL_PORT — bind port. */
  port: number;
  /** MEMWARE_KERNEL_TOKEN — Bearer token, min KERNEL_MIN_TOKEN_LENGTH chars. */
  token: string;
  /** MEMWARE_KERNEL_MAX_TEXTS — POST /embed batch ceiling. */
  maxTexts: number;
  /** MEMWARE_KERNEL_MAX_CANDIDATES — POST /search candidate-set ceiling. */
  maxCandidates: number;
  /** MEMWARE_KERNEL_TIMEOUT_MS — upstream call budget. */
  timeoutMs: number;
  /** True when the embedding transport differs from chat (URL or credential). */
  embeddingUsesSeparateEndpoint: boolean;
}

function readOptional(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Absolute http(s) URL, no embedded credentials, no fragment. */
function validateEndpoint(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KernelConfigError(`${key} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new KernelConfigError(`${key} must not contain URL credentials`);
  }
  if (url.hash) {
    throw new KernelConfigError(`${key} must not contain a URL fragment`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new KernelConfigError(`${key} must use HTTP or HTTPS`);
  }
  return url;
}

function readEndpoint(source: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = readOptional(source, key);
  if (value === undefined) return fallback;
  validateEndpoint(value, key);
  return value;
}

function readPositiveInt(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readOptional(source, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new KernelConfigError(`${key} must be a positive integer`);
  }
  return n;
}

/**
 * Parse the process environment into {@link KernelEnv}.
 *
 * @throws {KernelConfigError} when the Bearer token or API key is missing, the
 *   token is too short, a numeric var is malformed, an endpoint is not a clean
 *   absolute URL, or a distinct embedding origin has no credential of its own.
 */
export function loadKernelEnv(source: NodeJS.ProcessEnv = process.env): KernelEnv {
  const token = readOptional(source, "MEMWARE_KERNEL_TOKEN") ?? "";
  if (token.length < KERNEL_MIN_TOKEN_LENGTH) {
    throw new KernelConfigError(
      `MEMWARE_KERNEL_TOKEN is required (min ${KERNEL_MIN_TOKEN_LENGTH} chars). ` +
        "Generate one with: openssl rand -hex 32",
    );
  }

  const apiKey = readOptional(source, "MEMWARE_API_KEY");
  if (!apiKey) {
    throw new KernelConfigError(
      "MEMWARE_API_KEY is required. Set it to an OpenAI-compatible API key.",
    );
  }

  const baseUrl = readEndpoint(source, "MEMWARE_BASE_URL", DEFAULT_CONFIG.model.base_url);
  const embeddingBaseUrl = readEndpoint(source, "MEMWARE_EMBEDDING_BASE_URL", baseUrl);
  const chatOrigin = validateEndpoint(baseUrl, "MEMWARE_BASE_URL").origin;
  const embeddingOrigin = validateEndpoint(embeddingBaseUrl, "MEMWARE_EMBEDDING_BASE_URL").origin;
  const embeddingApiKey = readOptional(source, "MEMWARE_EMBEDDING_API_KEY");
  if (chatOrigin !== embeddingOrigin && !embeddingApiKey) {
    throw new KernelConfigError(
      "MEMWARE_EMBEDDING_API_KEY is required when MEMWARE_EMBEDDING_BASE_URL uses a different origin",
    );
  }

  const port = readPositiveInt(source, "MEMWARE_KERNEL_PORT", KERNEL_DEFAULT_PORT);
  if (port > 65535) {
    throw new KernelConfigError("MEMWARE_KERNEL_PORT must be an integer in [1, 65535]");
  }

  const embeddingDim = readOptional(source, "MEMWARE_EMBEDDING_DIM") === undefined
    ? undefined
    : readPositiveInt(source, "MEMWARE_EMBEDDING_DIM", 0);

  return {
    apiKey,
    baseUrl,
    model: readOptional(source, "MEMWARE_MODEL") ?? DEFAULT_CONFIG.model.model_name,
    embeddingModel:
      readOptional(source, "MEMWARE_EMBEDDING_MODEL") ?? DEFAULT_CONFIG.model.embedding_model,
    ...(embeddingDim !== undefined ? { embeddingDim } : {}),
    embeddingBaseUrl,
    embeddingApiKey: embeddingApiKey ?? apiKey,
    host: readOptional(source, "MEMWARE_KERNEL_HOST") ?? KERNEL_DEFAULT_HOST,
    port,
    token,
    maxTexts: readPositiveInt(source, "MEMWARE_KERNEL_MAX_TEXTS", KERNEL_DEFAULT_MAX_TEXTS),
    maxCandidates: readPositiveInt(
      source,
      "MEMWARE_KERNEL_MAX_CANDIDATES",
      KERNEL_DEFAULT_MAX_CANDIDATES,
    ),
    timeoutMs: readPositiveInt(source, "MEMWARE_KERNEL_TIMEOUT_MS", KERNEL_DEFAULT_TIMEOUT_MS),
    embeddingUsesSeparateEndpoint:
      embeddingBaseUrl !== baseUrl || (embeddingApiKey ?? apiKey) !== apiKey,
  };
}
