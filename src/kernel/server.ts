/**
 * memware kernel — HTTP surface (Bun.serve).
 *
 * Structure mirrors src/memware/httpServer.ts (Bearer + timingSafeEqual, one
 * switch, JSON errors) but shares no code with it: that server is single-tenant
 * and storage-backed, this one is stateless and must not import src/memware/*.
 *
 * Auth posture: every endpoint needs `Authorization: Bearer <token>` EXCEPT
 * `GET /health`, which container and k8s probes must be able to call without a
 * credential. The health body carries versions and model names only — never a
 * key, never any memory data.
 *
 * Privacy posture (handoff §5.4.3): every request logs exactly one line with
 * method, path, status, duration, item count and request id. Conversation text,
 * memory content, query text, userId and the Bearer token never reach the log.
 */

import { timingSafeEqual } from "node:crypto";
import type { KernelEnv } from "./env";
import {
  ExtractOutputInvalidError,
  UpstreamFailedError,
  UpstreamTimeoutError,
  type Extractor,
} from "./extract";
import { ExtractRequestSchema } from "./extractSchema";
import { EmbedRequestSchema, PayloadTooLargeError, type EmbedService } from "./embed";
import { DimensionMismatchError, SearchRequestSchema, type SearchService } from "./search";
import type { z } from "zod";

export interface KernelHandlerDeps {
  env: KernelEnv;
  extractor: Extractor;
  embedService: EmbedService;
  searchService: SearchService;
  version: { kernelVersion: string; extractorVersion: string };
}

/** Error codes are contract (contracts/kernel.v1.json); status follows the code. */
const ERROR_STATUS = {
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  invalid_request: 400,
  extract_output_invalid: 422,
  upstream_timeout: 504,
  upstream_failed: 502,
  payload_too_large: 413,
  dimension_mismatch: 422,
} as const;

type ErrorCode = keyof typeof ERROR_STATUS;

const ROUTES: ReadonlyMap<string, "GET" | "POST"> = new Map([
  ["/health", "GET"],
  ["/extract", "POST"],
  ["/embed", "POST"],
  ["/search", "POST"],
]);

/** The only unauthenticated path: liveness/readiness probes. */
const PUBLIC_PATH = "/health";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

class KernelHttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KernelHttpError";
  }
}

function json(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-request-id": requestId },
  });
}

function errorBody(code: ErrorCode, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

/** Inbound ids are echoed into logs, so only accept a safe, bounded shape. */
function resolveRequestId(header: string | null): string {
  const candidate = header?.trim() ?? "";
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : crypto.randomUUID();
}

/** Zod issues carry field paths and codes only — never the submitted values. */
function invalidRequest(error: z.ZodError): KernelHttpError {
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return new KernelHttpError("invalid_request", issues);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new KernelHttpError("invalid_request", "body must be valid JSON");
  }
}

/** Map a domain error onto its contract code; unknown errors are not swallowed. */
function toHttpError(err: unknown): KernelHttpError {
  if (err instanceof KernelHttpError) return err;
  if (err instanceof ExtractOutputInvalidError) {
    return new KernelHttpError("extract_output_invalid", err.message);
  }
  if (err instanceof UpstreamTimeoutError) return new KernelHttpError("upstream_timeout", err.message);
  if (err instanceof UpstreamFailedError) return new KernelHttpError("upstream_failed", err.message);
  if (err instanceof PayloadTooLargeError) return new KernelHttpError("payload_too_large", err.message);
  if (err instanceof DimensionMismatchError) {
    return new KernelHttpError("dimension_mismatch", err.message);
  }
  return new KernelHttpError("upstream_failed", err instanceof Error ? err.message : String(err));
}

interface RouteOutcome {
  body: unknown;
  /** Items produced (facts / vectors / results) — the only volume signal logged. */
  items: number;
}

async function runRoute(
  deps: KernelHandlerDeps,
  pathname: string,
  request: Request,
): Promise<RouteOutcome> {
  switch (pathname) {
    case "/health":
      return {
        body: {
          ok: true,
          service: "memware-kernel",
          version: deps.version.kernelVersion,
          extractorVersion: deps.version.extractorVersion,
          embeddingModel: deps.env.embeddingModel,
          embeddingDim: deps.env.embeddingDim ?? null,
        },
        items: 0,
      };

    case "/extract": {
      const parsed = ExtractRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw invalidRequest(parsed.error);
      const response = await deps.extractor.extract(parsed.data);
      return { body: response, items: response.facts.length };
    }

    case "/embed": {
      const parsed = EmbedRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw invalidRequest(parsed.error);
      const result = await deps.embedService.embed(parsed.data.texts);
      return { body: result, items: result.vectors.length };
    }

    case "/search": {
      const parsed = SearchRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw invalidRequest(parsed.error);
      const result = await deps.searchService.search(parsed.data);
      return { body: result, items: result.results.length };
    }

    default:
      throw new KernelHttpError("not_found", "unknown endpoint");
  }
}

/** Build the Bun.serve fetch handler. Pure wiring — no process state. */
export function createKernelHandler(deps: KernelHandlerDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    const requestId = resolveRequestId(request.headers.get("x-request-id"));
    const url = new URL(request.url);
    const pathname = url.pathname;

    let status = 200;
    let items = 0;
    let response: Response;
    try {
      if (pathname !== PUBLIC_PATH) {
        // Unknown paths are checked for auth first, so an anonymous caller
        // cannot enumerate the routing table through 404 vs 401.
        const presented = bearerToken(request.headers.get("authorization"));
        if (!presented || !tokenMatches(presented, deps.env.token)) {
          throw new KernelHttpError("unauthorized", "missing or invalid bearer token");
        }
      }
      const expectedMethod = ROUTES.get(pathname);
      if (expectedMethod === undefined) throw new KernelHttpError("not_found", "unknown endpoint");
      if (request.method !== expectedMethod) {
        throw new KernelHttpError("method_not_allowed", `expected ${expectedMethod} ${pathname}`);
      }

      const outcome = await runRoute(deps, pathname, request);
      items = outcome.items;
      response = json(outcome.body, status, requestId);
    } catch (err) {
      const httpError = toHttpError(err);
      status = ERROR_STATUS[httpError.code];
      response = json(errorBody(httpError.code, httpError.message), status, requestId);
    }

    const elapsed = Math.round(performance.now() - startedAt);
    console.error(
      `[memware-kernel] ${request.method} ${pathname} ${status} ${elapsed}ms items=${items} rid=${requestId}`,
    );
    return response;
  };
}

export interface RunningKernelServer {
  port: number;
  stop: () => void;
}

/** Start the service. The caller has already validated `env` via loadKernelEnv. */
export function startKernelServer(
  env: KernelEnv,
  deps: Omit<KernelHandlerDeps, "env">,
): RunningKernelServer {
  const server = Bun.serve({
    hostname: env.host,
    port: env.port,
    fetch: createKernelHandler({ ...deps, env }),
  });
  return { port: server.port ?? env.port, stop: () => server.stop(true) };
}
