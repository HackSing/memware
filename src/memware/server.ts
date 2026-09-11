/**
 * memware — MCP stdio server (`memware serve`).
 *
 * Exposes seven memory tools over the Model Context Protocol. Tool inputs are
 * declared as zod raw shapes; the SDK validates every call against them at the
 * boundary (single validation — handlers trust their typed args and pass
 * straight through to the memory pipeline). The server name is "memware".
 *
 * McpServer is the SDK's Server-based high-level facade: it still runs on the
 * low-level Server + StdioServerTransport, but accepts zod shapes directly so we
 * neither hand-write JSON Schemas nor pull in an extra schema-conversion
 * dependency (only @modelcontextprotocol/sdk is authorized).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveModelRuntimeConfig, type MemwareEnv } from "./env";
import { buildExtractionConfig, processTurn } from "./processTurn";
import {
  buildResumeBrief,
  DEFAULT_RESUME_THREAD_LIMIT,
  RELATED_PER_THREAD,
} from "./resume";
import type {
  RequestSecurityContext,
  TenantAction,
  TenantLease,
  TenantProvider,
} from "./tenantProvider";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Loose topic focus for memory_resume: case-insensitive substring in either direction. */
function topicIdentityMatch(threadTopic: string, topic: string): boolean {
  const a = threadTopic.toLowerCase();
  const b = topic.toLowerCase();
  return a.includes(b) || b.includes(a);
}

type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface MemwareServerOptions {
  /** Required for trusted-host-v1; derive identity only from authenticated host state. */
  resolveSecurityContext?: (
    extra: ToolRequestExtra,
  ) => RequestSecurityContext | Promise<RequestSecurityContext>;
}

/** Build the memware MCP server wired to a deployment-selected tenant provider. */
export function createMemwareServer(
  env: MemwareEnv,
  provider: TenantProvider,
  options: MemwareServerOptions = {},
): McpServer {
  if (provider.boundary === "trusted-host-v1" && !options.resolveSecurityContext) {
    throw new Error("trusted-host-v1 requires resolveSecurityContext");
  }
  const server = new McpServer(
    { name: "memware", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const extractionConfig = buildExtractionConfig(env);
  const modelConfig = resolveModelRuntimeConfig(env);

  const acquire = async (
    action: TenantAction,
    requestedUserId: string | undefined,
    extra: ToolRequestExtra,
  ): Promise<TenantLease> => {
    const securityContext = options.resolveSecurityContext
      ? await options.resolveSecurityContext(extra)
      : undefined;
    return provider.acquire({ action, requestedUserId, securityContext });
  };

  const withTenant = async <T>(
    action: TenantAction,
    requestedUserId: string | undefined,
    extra: ToolRequestExtra,
    operation: (lease: TenantLease) => Promise<T>,
  ): Promise<T> => {
    const lease = await acquire(action, requestedUserId, extra);
    try {
      return await operation(lease);
    } finally {
      await lease.release();
    }
  };

  server.registerTool(
    "memory_status",
    { description: "Report the sanitized memware security boundary and runtime status.", inputSchema: {} },
    async (_args, extra) => {
      return withTenant("status", undefined, extra, async (lease) => {
        const runtime = await lease.handle.run(async (memory) =>
          memory.getRuntimeStatus?.() ?? { kind: "unknown" },
        );
        return ok({
          server: "memware",
          ...provider.status(),
          agentId: env.agentId,
          storageLayoutVersion: "t1",
          permissionsSecure: true,
          resetState: lease.handle.lifecycleState,
          tenantRef: lease.tenantRef,
          modelConfiguration: {
            source: modelConfig.endpointSource,
            projectConfigDiscovery: false,
            chatEndpointOrigin: modelConfig.chatEndpointOrigin,
            embeddingEndpointOrigin: modelConfig.embeddingEndpointOrigin,
            embeddingUsesSeparateCredential: modelConfig.embeddingUsesSeparateCredential,
          },
          runtime,
        });
      });
    },
  );

  server.registerTool(
    "memory_warmup",
    { description: "Ensure the bound tenant profile exists (idempotent).", inputSchema: { userId: z.string().optional() } },
    async ({ userId }, extra) => {
      return withTenant("warmup", userId, extra, async (lease) => {
        await lease.handle.run((memory) => memory.warmup(lease.userId));
        return ok({ ok: true, userId: lease.userId, tenantRef: lease.tenantRef });
      });
    },
  );

  server.registerTool(
    "memory_get_context",
    {
      description: "Retrieve the bound tenant's memory context for a query.",
      inputSchema: { userId: z.string().optional(), query: z.string() },
    },
    async ({ userId, query }, extra) => {
      return withTenant("read", userId, extra, async (lease) => {
        const ctx = await lease.handle.run((memory) => memory.getContext(lease.userId, query));
        return ok({ system: ctx.prompts.system, context: ctx.prompts.context });
      });
    },
  );

  server.registerTool(
    "memory_process",
    {
      description: "Extract and persist memory from one conversation turn.",
      inputSchema: {
        userId: z.string().optional(),
        sessionId: z.string(),
        turnIndex: z.number().int().min(0),
        userMessage: z.string(),
        assistantMessage: z.string(),
      },
    },
    async ({ userId, sessionId, turnIndex, userMessage, assistantMessage }, extra) => {
      return withTenant("write", userId, extra, async (lease) => {
        const result = await lease.handle.run((memory) =>
          processTurn({
            memory,
            config: extractionConfig,
            auditDir: lease.handle.tenant.paths.auditDir,
            userId: lease.userId,
            sessionId,
            turnIndex,
            userMessage,
            assistantMessage,
            agentId: env.agentId,
          }),
        );
        return ok(result);
      });
    },
  );

  server.registerTool(
    "memory_search",
    {
      description: "Search the bound tenant's memory for a query.",
      inputSchema: { userId: z.string().optional(), query: z.string(), limit: z.number().int().positive().optional() },
    },
    async ({ userId, query, limit }, extra) => {
      return withTenant("search", userId, extra, async (lease) => {
        const [results, clusters] = await lease.handle.run((memory) =>
          Promise.all([
            memory.searchMemory(lease.userId, query, limit),
            memory.searchClusters(lease.userId, query, limit !== undefined ? { limit } : undefined),
          ]),
        );
        return ok({ results, clusters });
      });
    },
  );

  server.registerTool(
    "memory_resume",
    {
      description:
        "Cross-agent task handoff: list active task threads (with the last agent that touched " +
        "each) plus related memories, assembled into a briefing. Call at the start of a task " +
        "to continue work another agent left off. Optionally pass `topic` to focus one thread.",
      inputSchema: {
        userId: z.string().optional(),
        topic: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ userId, topic, limit }, extra) => {
      return withTenant("read", userId, extra, async (lease) => {
        const { threads, relatedByThread } = await lease.handle.run(async (memory) => {
          const all = memory.getActiveThreads
            ? await memory.getActiveThreads(lease.userId)
            : [];
          const focused = topic
            ? all.filter((t) => topicIdentityMatch(t.topic, topic))
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
        const result = buildResumeBrief(threads, relatedByThread);
        return ok(result);
      });
    },
  );

  server.registerTool(
    "memory_archive",
    { description: "Archive stale memory clusters for the bound tenant.", inputSchema: { userId: z.string().optional() } },
    async ({ userId }, extra) => {
      return withTenant("archive", userId, extra, async (lease) => {
        await lease.handle.run((memory) => memory.archive(lease.userId));
        return ok({ ok: true, userId: lease.userId, tenantRef: lease.tenantRef });
      });
    },
  );

  server.registerTool(
    "memory_reset",
    { description: "Delete all memory artifacts for the bound tenant.", inputSchema: { userId: z.string().optional() } },
    async ({ userId }, extra) => {
      return withTenant("reset", userId, extra, async (lease) => {
        const result = await lease.handle.reset();
        return ok({ ...result, userId: lease.userId, tenantRef: lease.tenantRef });
      });
    },
  );

  return server;
}
