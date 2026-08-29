/**
 * avatanel Memory System — Configuration
 *
 * JSON-based config with env interpolation. No YAML dependency.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { MemoryConfig } from "./types";

const ENV_PATTERN = /\$\{(\w+)(?::([^}]*))?\}/g;

// ── Default storage paths ─────────────────────────────────────────────────
//
// These mirror `getUserMemoryDbPath` / `getUserMemoryVectorPath` in
// src/agent/evolution/workspace.ts for the built-in "default" user, but are
// resolved locally and lazily (see the getters on DEFAULT_CONFIG.storage) so
// that importing the memory config never pulls the EvoLoop workspace subsystem
// into the module graph — the memory kernel must stay embeddable on its own.
// The layout (<usersRoot>/default/memory/{memory.db,vectors}) and the
// AVATANEL_USERS_ROOT override are a stable path contract; keep in sync with
// workspace.ts. "default" is already a path-safe segment, so no sanitization
// is needed here.

const DEFAULT_USER_ID = "default";

/** Default per-user workspace root; mirrors workspace.ts `defaultUsersRoot()`. */
function defaultUsersRoot(): string {
  return process.env.AVATANEL_USERS_ROOT ?? join(homedir(), ".avatanel", "user");
}

/** Default memory directory for the built-in "default" user. */
function defaultUserMemoryRoot(): string {
  return join(defaultUsersRoot(), DEFAULT_USER_ID, "memory");
}

function interpolateEnv(value: string): string {
  return value.replace(ENV_PATTERN, (_, varName, defaultVal) => {
    return process.env[varName] ?? defaultVal ?? "";
  });
}

function walkInterpolate(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(walkInterpolate);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = walkInterpolate(v);
    }
    return result;
  }
  return obj;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val)
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  model: {
    api_key: "",
    base_url: "https://api.siliconflow.cn/v1",
    model_name: "deepseek-ai/DeepSeek-V3.2",
    embedding_model: "Qwen/Qwen3-Embedding-8B",
    embedding_dim: 4096,
  },
  storage: {
    // Lazy getters: the default paths are resolved on first access (during
    // MemorySettings construction), never at module load — same values as
    // getUserMemoryDbPath("default") / getUserMemoryVectorPath("default").
    get sqlite_path(): string {
      return join(defaultUserMemoryRoot(), "memory.db");
    },
    get vector_db_path(): string {
      return join(defaultUserMemoryRoot(), "vectors");
    },
  },
  read: {
    vector_search_multiplier: 3,
    rerank_weights: { relevance: 0.6, recency: 0.25, type_weight: 0.15 },
    min_similarity: 0.55,
    rerank_threshold: 0.3,
    top_k: 5,
  },
  write: {
    memory_clusters_limit: 50,
    importance_decay_rate: 0.02,
    semantic_dedup_threshold: 0.8,
    active_threads_limit: 10,
    current_focus_limit: 3,
    significant_memories_limit: 50,
  },
  archive: {
    days_to_keep: 14,
  },
  cache: {
    profile_ttl: 900,
    embedding_ttl: 86400,
    high_frequency_threshold: 10,
    high_frequency_ttl: 1800,
  },
  multimodal: {
    enabled: true,
    max_image_bytes: 8 * 1024 * 1024,
    max_images_per_turn: 4,
  },
};

export class MemorySettings {
  private data: MemoryConfig;

  /**
   * Build memory settings from trusted defaults or an explicitly selected
   * config file. A no-argument construction intentionally never inspects
   * process.cwd(): project content must not gain authority over model
   * endpoints or credentials merely because the host runs inside that repo.
   *
   * The string overload remains for compatibility, but the path must be
   * absolute so selecting a file is an explicit caller decision.
   */
  constructor(source: MemorySettingsSource = { kind: "defaults" }) {
    const configPath =
      typeof source === "string"
        ? source
        : source.kind === "explicit-file"
          ? source.path
          : undefined;
    let fileConfig: Record<string, unknown> = {};

    if (configPath !== undefined && !isAbsolute(configPath)) {
      throw new Error("Memory config path must be absolute");
    }

    if (configPath !== undefined && existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      fileConfig = walkInterpolate(raw) as Record<string, unknown>;
    }

    this.data = deepMerge(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      fileConfig,
    ) as unknown as MemoryConfig;
  }

  static fromDefaults(): MemorySettings {
    return new MemorySettings({ kind: "defaults" });
  }

  static fromFile(configPath: string): MemorySettings {
    return new MemorySettings({ kind: "explicit-file", path: configPath });
  }

  get<K extends keyof MemoryConfig>(key: K): MemoryConfig[K] {
    return this.data[key];
  }

  getPath(dotPath: string, defaultVal?: unknown): unknown {
    const keys = dotPath.split(".");
    let obj: unknown = this.data;
    for (const k of keys) {
      if (obj !== null && typeof obj === "object" && k in (obj as Record<string, unknown>)) {
        obj = (obj as Record<string, unknown>)[k];
      } else {
        return defaultVal;
      }
    }
    return obj;
  }

  get config(): MemoryConfig {
    return this.data;
  }

  /**
   * Apply runtime overrides via deep merge. Accepts a deep-partial so callers
   * can supply nested overrides (e.g. `{model: {api_key: "..."}}`) without
   * having to fill in every sibling field of `ModelConfig`. The underlying
   * deepMerge is dynamic — it tolerates any partial shape.
   */
  updateRuntime(updates: DeepPartialMemoryConfig): void {
    this.data = deepMerge(
      this.data as unknown as Record<string, unknown>,
      updates as unknown as Record<string, unknown>,
    ) as unknown as MemoryConfig;
  }
}

export type MemorySettingsSource =
  | string
  | { kind: "defaults" }
  | { kind: "explicit-file"; path: string };

/** Recursive partial — required for `updateRuntime` nested merges. */
type DeepPartialMemoryConfig = {
  [K in keyof MemoryConfig]?: MemoryConfig[K] extends object
    ? { [KK in keyof MemoryConfig[K]]?: MemoryConfig[K][KK] }
    : MemoryConfig[K];
};

export function safeJsonParse<T = unknown>(text: string, defaultVal?: T): T {
  try {
    return JSON.parse(text);
  } catch {
    return (defaultVal ?? {}) as T;
  }
}
