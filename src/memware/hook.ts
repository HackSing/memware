/**
 * memware — Claude Code hook mode (`memware hook`).
 *
 * Reads a Stop-hook JSON payload from stdin (carrying `session_id` and
 * `transcript_path`), parses the referenced transcript, and writes the final
 * turn to memory through the SAME path as the memory_process tool
 * (buildExtractionConfig + processTurn).
 *
 * Contract: hook mode must NEVER block the host. Every failure is logged to
 * stderr and swallowed — runHook always resolves, and main.ts exits 0 no matter
 * what. The Stop hook "success" output is simply exit 0 with empty stdout.
 */

import { z } from "zod";
import { resolveHookTurn } from "./adapters";
import type { MemwareEnv } from "./env";
import { buildExtractionConfig, processTurn } from "./processTurn";
import type { TenantLease, TenantProvider } from "./tenantProvider";
import { getAdapter } from "./transcripts";
import { isTurnProcessed, markTurnProcessed, turnFingerprint } from "./turnState";

const HookInputSchema = z
  .object({
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
  })
  .passthrough();

export interface HookResult {
  wrote: boolean;
  reason?: string;
  actions?: number;
}

function logSkip(reason: string, detail?: unknown): HookResult {
  const suffix = detail === undefined ? "" : `: ${detail instanceof Error ? detail.message : String(detail)}`;
  console.error(`[memware hook] skipped (${reason})${suffix}`);
  return { wrote: false, reason };
}

/**
 * Process one Stop-hook invocation. Never throws — returns a result describing
 * what happened (useful for tests). Any error path resolves with wrote:false.
 */
export async function runHook(
  env: MemwareEnv,
  provider: TenantProvider,
  stdinText: string,
): Promise<HookResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinText);
  } catch (err) {
    return logSkip("hook-json-parse", err);
  }

  const hook = HookInputSchema.safeParse(parsed);
  if (!hook.success) {
    return logSkip("hook-json-invalid", hook.error.issues.map((i) => i.message).join("; "));
  }

  const resolved = resolveHookTurn(env.agentId, hook.data);
  if (!resolved.turn) return logSkip(resolved.reason, resolved.detail);

  const { turn, sessionId } = resolved;

  // Hosts that can re-fire their stop event for one finished turn opt in, so
  // the same turn is not extracted and stored twice.
  const dedupe = getAdapter(env.agentId).dedupeTurns === true;
  const fingerprint = dedupe ? turnFingerprint(turn.userMessage, turn.assistantMessage) : "";
  if (dedupe && isTurnProcessed(env.dataDir, env.agentId, sessionId, fingerprint)) {
    return logSkip("turn-already-processed");
  }

  let lease: TenantLease | undefined;
  try {
    lease = await provider.acquire({ action: "write" });
    const result = await lease.handle.run(async (memory, userId) => {
      await memory.warmup(userId);
      return processTurn({
        memory,
        config: buildExtractionConfig(env),
        auditDir: lease!.handle.tenant.paths.auditDir,
        userId,
        sessionId,
        turnIndex: turn.turnIndex,
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage,
        agentId: env.agentId,
      });
    });
    if (dedupe && result.ok) {
      markTurnProcessed(env.dataDir, env.agentId, sessionId, fingerprint);
    }
    return { wrote: result.ok, reason: result.error, actions: result.actions };
  } catch (err) {
    return logSkip("write-failed", err);
  } finally {
    await lease?.release();
  }
}
