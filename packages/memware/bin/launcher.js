#!/usr/bin/env node
"use strict";

/**
 * memware npm launcher (Node, standard library only).
 *
 * The `memware` package ships no binary itself. The platform-specific
 * self-contained executable arrives via one of the optionalDependencies
 * (memware-<platform>-<arch>). This launcher:
 *   1. resolves the subpackage matching process.platform/process.arch,
 *   2. locates its bundled binary,
 *   3. spawns it, forwarding argv, stdio (so MCP stdio + hook stdin/stdout
 *      pass straight through), and env, and
 *   4. forwards the child's exit code (and re-raises a killing signal).
 *
 * On an unsupported platform, or when the platform subpackage failed to install,
 * it fails loudly with the supported list — it never silently degrades.
 *
 * Deliberately standalone: this is a published, dependency-free file and cannot
 * import the repo's build scripts, so it keeps its own small platform map. Keep
 * it in sync with MEMWARE_TARGETS in scripts/memware-build.ts.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

/** `${process.platform}-${process.arch}` → platform subpackage name. */
const PLATFORM_PACKAGES = {
  "darwin-arm64": "memware-darwin-arm64",
  "linux-x64": "memware-linux-x64",
};

/** Binary filename inside each platform subpackage. */
const BINARY_NAME = process.platform === "win32" ? "memware.exe" : "memware";

function fail(message) {
  process.stderr.write(`[memware] ${message}\n`);
  process.exit(1);
}

/** Resolve the absolute path of this platform's memware binary, or exit(1). */
function resolveBinary() {
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) {
    fail(
      `unsupported platform "${key}". memware ships prebuilt binaries for: ` +
        `${Object.keys(PLATFORM_PACKAGES).join(", ")}.`,
    );
  }

  // Resolve the subpackage via its package.json (always resolvable when the
  // package is installed), then join the binary next to it. optionalDependencies
  // means an absent subpackage is a resolution failure, not an install error.
  let pkgJson;
  try {
    pkgJson = require.resolve(`${pkg}/package.json`);
  } catch (_err) {
    fail(
      `platform package "${pkg}" is not installed. It is an optionalDependency ` +
        `of memware and should have installed automatically for ${key}; reinstall ` +
        `with "npm install memware" (do not pass --no-optional / --omit=optional).`,
    );
  }
  return path.join(path.dirname(pkgJson), BINARY_NAME);
}

function main() {
  const binary = resolveBinary();
  const child = spawn(binary, process.argv.slice(2), {
    stdio: "inherit",
    env: process.env,
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, () => forward(signal));

  child.on("error", (err) => {
    fail(`failed to launch memware binary at ${binary}: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raise so the launcher exits the same way the binary did.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

main();
