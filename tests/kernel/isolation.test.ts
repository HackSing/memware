/**
 * Kernel dependency isolation (acceptance c4).
 *
 * The kernel ships as a container next to the backend: it must not be able to
 * open a SQLite database, speak MCP, or reach into the local product's modules.
 * This test walks the real runtime import graph from src/kernel/main.ts
 * (Bun.Transpiler drops type-only imports, so what is asserted is what actually
 * loads) and fails on any forbidden edge.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ENTRY = join(REPO_ROOT, "src/kernel/main.ts");

const FORBIDDEN_MODULES = ["bun:sqlite", "@modelcontextprotocol/sdk"];
/** Local-product entry points the kernel may consume (none today). */
const ALLOWED_MEMWARE_FILES = ["src/memware/adapters.ts"];
/** Local-state variables the kernel must never read. */
const FORBIDDEN_ENV_VARS = ["MEMWARE_DATA_DIR", "MEMWARE_USER_ID", "MEMWARE_AGENT_ID"];

interface ModuleGraph {
  /** Repo-relative paths of every source file the entry point pulls in. */
  files: string[];
  /** Bare specifiers (npm packages, bun: builtins, node: builtins). */
  external: Set<string>;
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // try the next shape
    }
  }
  throw new Error(`cannot resolve "${specifier}" from ${relative(REPO_ROOT, fromFile)}`);
}

function walk(entry: string): ModuleGraph {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const external = new Set<string>();
  const visited = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const imported of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (imported.path.startsWith(".")) {
        queue.push(resolveRelative(file, imported.path));
      } else {
        external.add(imported.path);
      }
    }
  }

  return { files: [...visited].map((f) => relative(REPO_ROOT, f)), external };
}

const graph = walk(ENTRY);

test("the kernel never loads SQLite or the MCP SDK", () => {
  for (const forbidden of FORBIDDEN_MODULES) {
    const hits = [...graph.external].filter((dep) => dep === forbidden || dep.startsWith(`${forbidden}/`));
    expect(hits).toEqual([]);
  }
});

test("the kernel only imports memory-kernel modules and its own files", () => {
  const outsiders = graph.files.filter(
    (file) =>
      !file.startsWith("src/kernel/") &&
      !file.startsWith("src/agent/memory/") &&
      !ALLOWED_MEMWARE_FILES.includes(file),
  );
  expect(outsiders).toEqual([]);

  const localProductFiles = graph.files.filter(
    (file) => file.startsWith("src/memware/") && !ALLOWED_MEMWARE_FILES.includes(file),
  );
  expect(localProductFiles).toEqual([]);
  expect(graph.files).toContain("src/kernel/server.ts");
});

test("the kernel reads no local-state environment variables", () => {
  const offenders: string[] = [];
  for (const file of graph.files) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const variable of FORBIDDEN_ENV_VARS) {
      // Only an actual read counts: the name must appear as a string literal or
      // a property access, not merely in a comment explaining why it is absent.
      const read = new RegExp(`(["'\`]${variable}["'\`]|\\.${variable}\\b)`);
      if (read.test(source)) offenders.push(`${file}:${variable}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the kernel's third-party surface stays small", () => {
  // node:fs / node:os / node:path come from the shared memory config module
  // (DEFAULT_CONFIG); the kernel itself opens nothing.
  expect([...graph.external].sort()).toEqual([
    "node:crypto",
    "node:fs",
    "node:os",
    "node:path",
    "openai",
    "zod",
  ]);
});
