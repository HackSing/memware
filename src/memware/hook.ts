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

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MemwareEnv } from "./env";
import { buildExtractionConfig, processTurn } from "./processTurn";
import { getAdapter } from "./transcripts";
import type { LastTurn } from "./transcript";
import type { TenantLease, TenantProvider } from "./tenantProvider";

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
 * Resolve the last turn for this hook invocation using the agent's adapter:
 * prefer a transcript file when the payload carries one, otherwise let the
 * adapter pull the turn inline from the payload (e.g. Codex notify).
 * Returns null (with a skip reason) when nothing usable is found.
 */
export function resolveHookTurn(
  agentId: string,
  hook: { session_id?: string; transcript_path?: string } & Record<string, unknown>,
): { turn: LastTurn; sessionId: string } | { turn: null; reason: string; detail?: unknown } {
  const adapter = getAdapter(agentId);
  const sessionId = hook.session_id ?? `memware-hook-${agentId}`;

  if (hook.transcript_path) {
    let transcriptText: string;
    try {
      transcriptText = readFileSync(hook.transcript_path, "utf8");
    } catch (err) {
      return { turn: null, reason: "transcript-unreadable", detail: err };
    }
    if (!adapter.extractLastTurn) {
      return { turn: null, reason: `adapter-without-transcript-support:${adapter.id}` };
    }
    const turn = adapter.extractLastTurn(transcriptText);
    return turn ? { turn, sessionId } : { turn: null, reason: "no-user-turn" };
  }

  if (adapter.extractFromHookPayload) {
    const turn = adapter.extractFromHookPayload(hook);
    return turn ? { turn, sessionId } : { turn: null, reason: "no-user-turn" };
  }
  return { turn: null, reason: "no-transcript-path" };
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
    return { wrote: result.ok, reason: result.error, actions: result.actions };
  } catch (err) {
    return logSkip("write-failed", err);
  } finally {
    await lease?.release();
  }
}
