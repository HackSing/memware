/**
 * memware — local HTTP API (`memware http`).
 *
 * Gives non-MCP agents and local scripts read/write access to the same
 * single-tenant memory store the stdio server uses. Security posture:
 *
 *   • Binds 127.0.0.1 by default. A non-loopback MEMWARE_HTTP_HOST is refused
 *     at startup — this service exposes personal memory and must never listen
 *     on an external interface.
 *   • Requires MEMWARE_HTTP_TOKEN. Every request must present
 *     `Authorization: Bearer <token>`; a missing/short token fails at startup
 *     rather than starting unauthenticated.
 *   • Reuses SingleTenantProvider: the caller cannot select a tenant, exactly
 *     like stdio serve mode. The optional `agentId` body field is provenance
 *     metadata only (stamped into writes), never an identity.
 *
 * Handler logic mirrors the MCP tools and funnels into the same
 * buildExtractionConfig/processTurn/resume pipeline.
 */

import { timingSafeEqual } from "node:crypto";
import { MemwareConfigError, type MemwareEnv } from "./env";
import { buildExtractionConfig, processTurn } from "./processTurn";
import { buildResumeBrief, DEFAULT_RESUME_THREAD_LIMIT, RELATED_PER_THREAD } from "./resume";
import type { TenantProvider, TenantAction, TenantLease } from "./tenantProvider";

export interface HttpServerOptions {
  host: string;
  port: number;
  token: string;
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const DEFAULT_HTTP_PORT = 18970;

/** Resolve and validate HTTP transport settings from the process environment. */
export function resolveHttpOptions(source: NodeJS.ProcessEnv = process.env): HttpServerOptions {
  const host = source.MEMWARE_HTTP_HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new MemwareConfigError(
      `MEMWARE_HTTP_HOST must be a loopback address (127.0.0.1 / localhost / ::1), got "${host}". ` +
        "The memory API must not listen on an external interface.",
    );
  }
  const token = source.MEMWARE_HTTP_TOKEN?.trim() ?? "";
  if (token.length < 16) {
    throw new MemwareConfigError(
      "MEMWARE_HTTP_TOKEN is required for `memware http` (min 16 chars). Generate one with: openssl rand -hex 32",
    );
  }
  const portRaw = source.MEMWARE_HTTP_PORT?.trim();
  const port = portRaw !== undefined && portRaw.length > 0 ? Number(portRaw) : DEFAULT_HTTP_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MemwareConfigError(`MEMWARE_HTTP_PORT must be an integer in [1, 65535], got "${portRaw}"`);
  }
  return { host, port, token };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1";
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError("body must be valid JSON", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError("body must be a JSON object", 400);
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(`"${field}" must be a non-empty string`, 400);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function optionalInt(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(`"${field}" must be a non-negative integer`, 400);
  }
  return value;
}

async function withLease<T>(
  provider: TenantProvider,
  action: TenantAction,
  operation: (lease: TenantLease) => Promise<T>,
): Promise<T> {
  let lease: TenantLease | undefined;
  try {
    lease = await provider.acquire({ action });
    return await operation(lease);
  } finally {
    await lease?.release();
  }
}

/** Build the Bun.serve fetch handler wired to the single-tenant provider. */
export function createHttpHandler(
  env: MemwareEnv,
  provider: TenantProvider,
  options: HttpServerOptions,
): (request: Request) => Promise<Response> {
  const extractionConfig = buildExtractionConfig(env);

  return async (request: Request): Promise<Response> => {
    const presented = bearerToken(request.headers.get("authorization"));
    if (!presented || !tokenMatches(presented, options.token)) {
      return fail("unauthorized: missing or invalid bearer token", 401);
    }

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          server: "memware",
          tenantBoundary: provider.boundary,
          agentId: env.agentId,
        });
      }

      if (request.method !== "POST") {
        return fail("method not allowed", 405);
      }
      const body = await readJsonBody(request);

      switch (url.pathname) {
        case "/v1/process": {
          const sessionId = requireString(body, "sessionId");
          const userMessage = requireString(body, "userMessage");
          const assistantMessage = requireString(body, "assistantMessage");
          const turnIndex = optionalInt(body, "turnIndex") ?? 0;
          const writerAgentId = optionalString(body, "agentId") ?? env.agentId;
          if (!AGENT_ID_PATTERN.test(writerAgentId)) {
            return fail('"agentId" must be 1-64 chars of [A-Za-z0-9._-]', 400);
          }
          return await withLease(provider, "write", async (lease) => {
            const result = await lease.handle.run(async (memory, userId) => {
              await memory.warmup(userId);
              return processTurn({
                memory,
                config: extractionConfig,
                auditDir: lease.handle.tenant.paths.auditDir,
                userId,
                sessionId,
                turnIndex,
                userMessage,
                assistantMessage,
                agentId: writerAgentId,
              });
            });
            return json(result);
          });
        }

        case "/v1/context": {
          const query = requireString(body, "query");
          return await withLease(provider, "read", async (lease) => {
            const ctx = await lease.handle.run((memory) => memory.getContext(lease.userId, query));
            return json({ system: ctx.prompts.system, context: ctx.prompts.context });
          });
        }

        case "/v1/search": {
          const query = requireString(body, "query");
          const limit = optionalInt(body, "limit");
          return await withLease(provider, "search", async (lease) => {
            const [results, clusters] = await lease.handle.run((memory) =>
              Promise.all([
                memory.searchMemory(lease.userId, query, limit),
                memory.searchClusters(lease.userId, query, limit !== undefined ? { limit } : undefined),
              ]),
            );
            return json({ results, clusters });
          });
        }

        case "/v1/resume": {
          const topic = optionalString(body, "topic");
          const limit = optionalInt(body, "limit");
          return await withLease(provider, "read", async (lease) => {
            const { threads, relatedByThread } = await lease.handle.run(async (memory) => {
              const all = memory.getActiveThreads ? await memory.getActiveThreads(lease.userId) : [];
              const focused = topic
                ? all.filter((t) => {
                    const a = t.topic.toLowerCase();
                    const b = topic.toLowerCase();
                    return a.includes(b) || b.includes(a);
                  })
                : all;
              const top = focused.slice(0, limit ?? DEFAULT_RESUME_THREAD_LIMIT);
              const related = await Promise.all(
                top.map((t) =>
                  memory
                    .searchClusters(lease.userId, t.topic, { limit: RELATED_PER_THREAD })
                    .catch(() => []),
                ),
              );
              return { threads: top, relatedByThread: related };
            });
            return json(buildResumeBrief(threads, relatedByThread));
          });
        }

        default:
          return fail("not found", 404);
      }
    } catch (err) {
      if (err instanceof HttpError) return fail(err.message, err.status);
      return fail(`internal error: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  };
}

export interface RunningHttpServer {
  port: number;
  stop: () => void;
}

/** Validate options, start Bun.serve on the loopback host, return a stop handle. */
export async function startHttpServer(
  env: MemwareEnv,
  provider: TenantProvider,
  options: HttpServerOptions,
): Promise<RunningHttpServer> {
  const fetch = createHttpHandler(env, provider, options);
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch,
  });
  // server.port is undefined in Bun's types when listening on an OS-picked
  // port; we always pass an explicit port, so fall back to it.
  return { port: server.port ?? options.port, stop: () => server.stop(true) };
}
