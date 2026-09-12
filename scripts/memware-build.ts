/**
 * memware — cross-platform single-file binary build.
 *
 * Compiles an entry point into self-contained executables via
 * `bun build --compile --target=...`. Each product embeds the Bun runtime plus
 * its own module graph, so it runs with no avatanel source tree and no Bun on
 * the host. Output lands in dist/ (gitignored).
 *
 * Two products share one platform matrix:
 *   • {@link MEMWARE_PRODUCT} — the local CLI (MCP serve / http / hook).
 *   • {@link KERNEL_PRODUCT}  — the stateless kernel service (`--kernel`).
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
  {
    key: "windows-x64",
    bunTarget: "bun-windows-x64",
    os: "win32",
    cpu: "x64",
    binaryFile: "memware-windows-x64.exe",
    packageName: "memware-windows-x64",
  },
];

/** Repo-root-relative locations shared by the build and pack steps. */
export const MEMWARE_ENTRY = "src/memware/main.ts";
export const MEMWARE_DIST_DIR = "dist/memware";
/** Binary name inside each platform subpackage (what the launcher spawns). */
export const MEMWARE_PACKAGE_BINARY = "memware";

/** One compilable product: an entry point plus where its binaries land. */
export interface BuildProduct {
  /** CLI label used in build logs. */
  name: string;
  /** Repo-root-relative entry module. */
  entry: string;
  /** Output directory for this product's binaries. */
  distDir: string;
  /** Replaces the leading "memware" of {@link MemwareTarget.binaryFile}. */
  binaryPrefix: string;
}

export const MEMWARE_PRODUCT: BuildProduct = {
  name: "memware",
  entry: MEMWARE_ENTRY,
  distDir: MEMWARE_DIST_DIR,
  binaryPrefix: "memware",
};

/** Stateless kernel service: no MCP, no SQLite, deployed as a container. */
export const KERNEL_PRODUCT: BuildProduct = {
  name: "kernel",
  entry: "src/kernel/main.ts",
  distDir: "dist/kernel",
  binaryPrefix: "memware-kernel",
};

/** Repo-relative path of a target's compiled binary in dist/. */
export function distBinaryPath(
  target: MemwareTarget,
  product: BuildProduct = MEMWARE_PRODUCT,
): string {
  return join(product.distDir, target.binaryFile.replace(/^memware/, product.binaryPrefix));
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

function humanSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}M`;
}

/** Compile one target. Throws (non-zero) on any build failure. */
async function buildTarget(target: MemwareTarget, product: BuildProduct): Promise<void> {
  const outfile = distBinaryPath(target, product);
  await mkdir(dirname(outfile), { recursive: true });
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      `--outfile=${outfile}`,
      product.entry,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`bun build failed for ${target.bunTarget} (exit ${code})`);
  }
  console.error(
    `[${product.name}:build] ${outfile} → ${humanSize(await fileSize(outfile))}`,
  );
}

/** Compile every supported target, or the MEMWARE_BUILD_TARGETS subset. */
export async function buildAll(product: BuildProduct = MEMWARE_PRODUCT): Promise<void> {
  const raw = process.env.MEMWARE_BUILD_TARGETS?.trim();
  let targets = MEMWARE_TARGETS;
  if (raw) {
    const wanted = new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    targets = MEMWARE_TARGETS.filter((t) => wanted.has(t.key));
    if (targets.length === 0) {
      throw new Error(
        `MEMWARE_BUILD_TARGETS matched nothing (wanted: ${[...wanted].join(", ")}; known: ${MEMWARE_TARGETS.map((t) => t.key).join(", ")})`,
      );
    }
  }
  await mkdir(product.distDir, { recursive: true });
  for (const target of targets) {
    await buildTarget(target, product);
  }
}

if (import.meta.main) {
  const product = process.argv.includes("--kernel") ? KERNEL_PRODUCT : MEMWARE_PRODUCT;
  buildAll(product).catch((err) => {
    console.error(`[${product.name}:build] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
