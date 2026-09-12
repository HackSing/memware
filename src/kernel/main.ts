/**
 * memware kernel — service entry point (`bun run kernel:serve`, container CMD).
 *
 * Wiring only: environment → LLM clients → services → HTTP server. The kernel
 * is stateless, so there is nothing to open, migrate or close on startup.
 */

import { OpenAIMemoryClient } from "../agent/memory/llmClient";
import { KernelConfigError, loadKernelEnv, type KernelEnv } from "./env";
import { createEmbedService } from "./embed";
import { createExtractor } from "./extract";
import { createSearchService } from "./search";
import { startKernelServer, type RunningKernelServer } from "./server";
import { extractorVersion, kernelVersion } from "./version";

/** Build every service from a validated environment and start listening. */
export function startKernelFromEnv(env: KernelEnv): RunningKernelServer {
  const chatClient = new OpenAIMemoryClient({ apiKey: env.apiKey, baseURL: env.baseUrl });
  const embeddingClient = env.embeddingUsesSeparateEndpoint
    ? new OpenAIMemoryClient({ apiKey: env.embeddingApiKey, baseURL: env.embeddingBaseUrl })
    : chatClient;

  const embedService = createEmbedService({
    llm: embeddingClient,
    model: env.embeddingModel,
    ...(env.embeddingDim !== undefined ? { dim: env.embeddingDim } : {}),
    maxTexts: env.maxTexts,
    timeoutMs: env.timeoutMs,
  });

  return startKernelServer(env, {
    extractor: createExtractor({
      llm: chatClient,
      model: env.model,
      timeoutMs: env.timeoutMs,
    }),
    embedService,
    searchService: createSearchService({ embed: embedService, maxCandidates: env.maxCandidates }),
    version: { kernelVersion, extractorVersion },
  });
}

if (import.meta.main) {
  try {
    const env = loadKernelEnv();
    const server = startKernelFromEnv(env);
    console.error(
      `[memware-kernel] listening on http://${env.host}:${server.port} ` +
        `version=${kernelVersion} extractorVersion=${extractorVersion} model=${env.model} ` +
        `embeddingModel=${env.embeddingModel}`,
    );
  } catch (err) {
    const message = err instanceof KernelConfigError ? err.message : String(err);
    console.error(`[memware-kernel] startup failed: ${message}`);
    process.exit(1);
  }
}
