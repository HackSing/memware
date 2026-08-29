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
import { loadEnv, type MemwareEnv } from "./env";
import { createMemwareServer } from "./server";
import { runHook } from "./hook";
import { createSingleTenantProvider, type TenantProvider } from "./tenantProvider";

const USAGE = `Usage: memware <serve|hook>

  serve   Start the MCP stdio server (memory tools for MCP clients).
  hook    Run as a Claude Code Stop hook; reads hook JSON from stdin.

Environment:
  MEMWARE_API_KEY          (required) OpenAI-compatible API key.
  MEMWARE_BASE_URL         OpenAI-compatible endpoint.
  MEMWARE_MODEL            Chat/extractor model name (default: kernel built-in).
  MEMWARE_EMBEDDING_MODEL  Embedding model name.
  MEMWARE_EMBEDDING_DIM    Embedding vector dimension.
  MEMWARE_EMBEDDING_BASE_URL  Optional separate embedding endpoint.
  MEMWARE_EMBEDDING_API_KEY   Required when embedding uses a different origin.
  MEMWARE_DATA_DIR         Storage root (default ~/.memware).
  MEMWARE_USER_ID          Process-bound tenant id (default "default").`;

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
  let provider: TenantProvider;
  try {
    env = loadEnv();
    provider = createSingleTenantProvider(env);
  } catch (err) {
    console.error(`[memware] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  warnIfModelMissing(env);

  const server = createMemwareServer(env, provider);

  const shutdown = async (): Promise<void> => {
    await provider.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(new StdioServerTransport());
  console.error("[memware] serve ready — single-tenant boundary active");
}

async function hook(): Promise<void> {
  // Hook mode never blocks the host: any failure logs to stderr and exits 0.
  try {
    const env = loadEnv();
    const provider = createSingleTenantProvider(env);
    const stdinText = await Bun.stdin.text();
    await runHook(env, provider, stdinText);
    await provider.close();
  } catch (err) {
    console.error(`[memware hook] ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  // memware owns a private process; restrict all newly created files even when
  // a downstream library does not pass explicit modes (e.g. SQLite sidecars).
  process.umask(0o077);
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
