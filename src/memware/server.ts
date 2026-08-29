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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MemwareEnv } from "./env";
import type { MemoryRegistry } from "./memoryRegistry";
import { userStorePaths } from "./paths";
import { buildExtractionConfig, processTurn } from "./processTurn";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Build the memware MCP server wired to a memory registry. */
export function createMemwareServer(env: MemwareEnv, registry: MemoryRegistry): McpServer {
  const server = new McpServer(
    { name: "memware", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const extractionConfig = buildExtractionConfig(env);
  const uid = (userId?: string): string => userId ?? env.defaultUserId;

  server.registerTool(
    "memory_status",
    { description: "Report memware storage location and memory runtime status.", inputSchema: {} },
    async () => {
      const user = env.defaultUserId;
      const paths = userStorePaths(env.dataDir, user);
      const memory = await registry.get(user);
      return ok({
        server: "memware",
        dataDir: env.dataDir,
        defaultUserId: user,
        storage: { dbPath: paths.dbPath, vectorDbPath: paths.vectorDbPath },
        runtime: memory.getRuntimeStatus?.() ?? { kind: "unknown" },
      });
    },
  );

  server.registerTool(
    "memory_warmup",
    { description: "Ensure a user profile exists (idempotent).", inputSchema: { userId: z.string().optional() } },
    async ({ userId }) => {
      const user = uid(userId);
      await (await registry.get(user)).warmup(user);
      return ok({ ok: true, userId: user });
    },
  );

  server.registerTool(
    "memory_get_context",
    {
      description: "Retrieve memory context (system + context text) for a query.",
      inputSchema: { userId: z.string().optional(), query: z.string() },
    },
    async ({ userId, query }) => {
      const user = uid(userId);
      const ctx = await (await registry.get(user)).getContext(user, query);
      return ok({ system: ctx.prompts.system, context: ctx.prompts.context });
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
    async ({ userId, sessionId, turnIndex, userMessage, assistantMessage }) => {
      const user = uid(userId);
      const result = await processTurn({
        memory: await registry.get(user),
        config: extractionConfig,
        auditDir: userStorePaths(env.dataDir, user).auditDir,
        userId: user,
        sessionId,
        turnIndex,
        userMessage,
        assistantMessage,
      });
      return ok(result);
    },
  );

  server.registerTool(
    "memory_search",
    {
      description: "Search a user's memory for a query.",
      inputSchema: { userId: z.string().optional(), query: z.string(), limit: z.number().int().positive().optional() },
    },
    async ({ userId, query, limit }) => {
      const user = uid(userId);
      const memory = await registry.get(user);
      const [results, clusters] = await Promise.all([
        memory.searchMemory(user, query, limit),
        memory.searchClusters(user, query, limit !== undefined ? { limit } : undefined),
      ]);
      return ok({ results, clusters });
    },
  );

  server.registerTool(
    "memory_archive",
    { description: "Archive stale memory clusters for a user.", inputSchema: { userId: z.string().optional() } },
    async ({ userId }) => {
      const user = uid(userId);
      await (await registry.get(user)).archive(user);
      return ok({ ok: true, userId: user });
    },
  );

  server.registerTool(
    "memory_reset",
    { description: "Reset a user's memory.", inputSchema: { userId: z.string().optional() } },
    async ({ userId }) => {
      const user = uid(userId);
      await (await registry.get(user)).reset(user);
      return ok({ ok: true, userId: user });
    },
  );

  return server;
}
