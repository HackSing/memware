/**
 * memware — CLI entry point.
 *
 * Two subcommands, argv-parsed (no CLI framework):
 *   memware serve   Run the MCP stdio server exposing memory tools.
 *   memware hook    Run once as a Claude Code Stop hook (stdin = hook JSON).
 *
 * serve exits non-zero on a config error (e.g. missing MEMWARE_API_KEY). hook
 * always exits 0 — it must never block the host, even on misconfiguration.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CONFIG } from "../agent/memory/config";
import { loadEnv, MemwareConfigError, type MemwareEnv } from "./env";
import { createDefaultServiceFactory, MemoryRegistry } from "./memoryRegistry";
import { createMemwareServer } from "./server";
import { runHook } from "./hook";

const USAGE = `Usage: memware <serve|hook>

  serve   Start the MCP stdio server (memory tools for MCP clients).
  hook    Run as a Claude Code Stop hook; reads hook JSON from stdin.

Environment:
  MEMWARE_API_KEY          (required) OpenAI-compatible API key.
  MEMWARE_BASE_URL         OpenAI-compatible endpoint.
  MEMWARE_MODEL            Chat/extractor model name (default: kernel built-in).
  MEMWARE_EMBEDDING_MODEL  Embedding model name.
  MEMWARE_EMBEDDING_DIM    Embedding vector dimension.
  MEMWARE_DATA_DIR         Storage root (default ~/.memware).
  MEMWARE_USER_ID          Default user id (default "default").`;

function warnIfModelMissing(env: MemwareEnv): void {
  // Extraction falls back to the kernel default model, which pairs with the
  // kernel default endpoint. Warn only when the endpoint is overridden but the
  // model is not — that pairing is the user's responsibility.
  if (!env.model && env.baseUrl) {
    console.error(
      `[memware] MEMWARE_MODEL is unset while MEMWARE_BASE_URL overrides the default endpoint; ` +
        `extraction will use the built-in default model "${DEFAULT_CONFIG.model.model_name}", which your endpoint may not serve. ` +
        "Set MEMWARE_MODEL to your chat model.",
    );
  }
}

async function serve(): Promise<void> {
  let env: MemwareEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof MemwareConfigError) {
      console.error(`[memware] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  warnIfModelMissing(env);

  const registry = new MemoryRegistry(createDefaultServiceFactory(env));
  const server = createMemwareServer(env, registry);

  const shutdown = async (): Promise<void> => {
    await registry.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(new StdioServerTransport());
  console.error(`[memware] serve ready — data dir ${env.dataDir}`);
}

async function hook(): Promise<void> {
  // Hook mode never blocks the host: any failure logs to stderr and exits 0.
  try {
    const env = loadEnv();
    const registry = new MemoryRegistry(createDefaultServiceFactory(env));
    const stdinText = await Bun.stdin.text();
    await runHook(env, registry, stdinText);
    await registry.closeAll();
  } catch (err) {
    console.error(`[memware hook] ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "serve":
      await serve();
      return;
    case "hook":
      await hook();
      return;
    case "-h":
    case "--help":
      console.log(USAGE);
      process.exit(0);
      return;
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
