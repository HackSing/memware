/**
 * memware — npm package assembly + `npm pack`.
 *
 * Pipeline: build binaries → copy each into its platform subpackage → `npm pack`
 * the main package and every platform subpackage into dist/memware/.
 *
 * The platform binaries copied into each packages/memware-<plat> subpackage are
 * build artifacts (gitignored); only the package.json + launcher are committed.
 * This step is the only writer of those binary slots.
 */

import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MEMWARE_DIST_DIR,
  MEMWARE_PACKAGE_BINARY,
  MEMWARE_TARGETS,
  buildAll,
  distBinaryPath,
} from "./memware-build";

const PACKAGES_DIR = "packages";
/** The npm main package directory (bin launcher + optionalDependencies). */
const MAIN_PACKAGE_DIR = join(PACKAGES_DIR, "memware");

function humanSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** Copy each freshly built binary into its platform subpackage, executable. */
async function assemblePlatformPackages(): Promise<void> {
  for (const target of MEMWARE_TARGETS) {
    const dest = join(PACKAGES_DIR, target.packageName, MEMWARE_PACKAGE_BINARY);
    await copyFile(distBinaryPath(target), dest);
    await chmod(dest, 0o755);
    const { size } = await stat(dest);
    console.error(`[memware:pack] ${target.packageName}/${MEMWARE_PACKAGE_BINARY} ← ${humanSize(size)}`);
  }
}

/** `npm pack <dir> --pack-destination dist/memware`. Throws on non-zero exit. */
async function npmPack(packageDir: string): Promise<void> {
  const proc = Bun.spawn(
    ["npm", "pack", `./${packageDir}`, "--pack-destination", MEMWARE_DIST_DIR],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`npm pack failed for ${packageDir} (exit ${code})`);
  }
}

async function packAll(): Promise<void> {
  await buildAll();
  await mkdir(MEMWARE_DIST_DIR, { recursive: true });
  await assemblePlatformPackages();
  await npmPack(MAIN_PACKAGE_DIR);
  for (const target of MEMWARE_TARGETS) {
    await npmPack(join(PACKAGES_DIR, target.packageName));
  }
  console.error(`[memware:pack] tarballs written to ${MEMWARE_DIST_DIR}/`);
}

if (import.meta.main) {
  packAll().catch((err) => {
    console.error(`[memware:pack] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
