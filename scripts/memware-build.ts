/**
 * memware — cross-platform single-file binary build.
 *
 * Compiles src/memware/main.ts into self-contained executables via
 * `bun build --compile --target=...`. Each product embeds the Bun runtime plus
 * the entire memory kernel, so it runs with no avatanel source tree and no Bun
 * on the host. Output lands in dist/memware/ (gitignored).
 *
 * {@link MEMWARE_TARGETS} is the single source of truth for the supported
 * platform matrix: the build reads bunTarget/binaryFile, the pack step reads
 * packageName/os/cpu. The npm launcher ships its own tiny platform map (it is a
 * published, dependency-free Node file that cannot import from scripts/).
 */

import { mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

/** One supported platform. Drives both the binary build and the npm packaging. */
export interface MemwareTarget {
  /** `${process.platform}-${process.arch}` key the launcher matches against. */
  key: string;
  /** `bun build --target` value. */
  bunTarget: string;
  /** package.json `os` value for the platform subpackage. */
  os: string;
  /** package.json `cpu` value for the platform subpackage. */
  cpu: string;
  /** dist/ output filename for this platform's binary. */
  binaryFile: string;
  /** npm platform subpackage name (also the optionalDependency key). */
  packageName: string;
}

export const MEMWARE_TARGETS: MemwareTarget[] = [
  {
    key: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    binaryFile: "memware-darwin-arm64",
    packageName: "memware-darwin-arm64",
  },
  {
    key: "linux-x64",
    bunTarget: "bun-linux-x64",
    os: "linux",
    cpu: "x64",
    binaryFile: "memware-linux-x64",
    packageName: "memware-linux-x64",
  },
];

/** Repo-root-relative locations shared by the build and pack steps. */
export const MEMWARE_ENTRY = "src/memware/main.ts";
export const MEMWARE_DIST_DIR = "dist/memware";
/** Binary name inside each platform subpackage (what the launcher spawns). */
export const MEMWARE_PACKAGE_BINARY = "memware";

/** Absolute path of a target's compiled binary in dist/. */
export function distBinaryPath(target: MemwareTarget): string {
  return join(MEMWARE_DIST_DIR, target.binaryFile);
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

function humanSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}M`;
}

/** Compile one target. Throws (non-zero) on any build failure. */
async function buildTarget(target: MemwareTarget): Promise<void> {
  const outfile = distBinaryPath(target);
  await mkdir(dirname(outfile), { recursive: true });
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      `--outfile=${outfile}`,
      MEMWARE_ENTRY,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`bun build failed for ${target.bunTarget} (exit ${code})`);
  }
  console.error(`[memware:build] ${target.binaryFile} → ${humanSize(await fileSize(outfile))}`);
}

/** Compile every supported target. */
export async function buildAll(): Promise<void> {
  await mkdir(MEMWARE_DIST_DIR, { recursive: true });
  for (const target of MEMWARE_TARGETS) {
    await buildTarget(target);
  }
}

if (import.meta.main) {
  buildAll().catch((err) => {
    console.error(`[memware:build] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
