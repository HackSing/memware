import { readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ignoredDirectories = new Set([".git", "node_modules", "dist"]);
const failures: string[] = [];

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else files.push(path);
  }

  return files;
}

function repositoryRelative(path: string): string {
  return path.slice(root.length + 1);
}

async function checkMarkdownLinks(files: string[]): Promise<void> {
  const markdownFiles = files.filter((file) => extname(file).toLowerCase() === ".md");
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (const file of markdownFiles) {
    const source = await Bun.file(file).text();
    for (const match of source.matchAll(linkPattern)) {
      const rawTarget = match[1]?.trim().replace(/^<|>$/g, "");
      if (!rawTarget || /^(https?:|mailto:|#)/i.test(rawTarget)) continue;
      const pathPart = rawTarget.split("#", 1)[0];
      if (!pathPart) continue;
      const target = resolve(file, "..", decodeURIComponent(pathPart));
      if (!(await Bun.file(target).exists())) {
        failures.push(`${repositoryRelative(file)}: missing local link target ${rawTarget}`);
      }
    }
  }

  console.log(`[content] checked ${markdownFiles.length} Markdown files`);
}

function checkYaml(files: string[]): void {
  const yamlFiles = files.filter((file) => [".yml", ".yaml"].includes(extname(file).toLowerCase()));
  if (yamlFiles.length === 0) return;

  const ruby = [
    'require "yaml"',
    'ARGV.each { |file| YAML.load_file(file) }',
  ].join("; ");
  const result = Bun.spawnSync(["ruby", "-e", ruby, "--", ...yamlFiles], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    failures.push(`YAML parse failed:\n${result.stderr.toString().trim()}`);
  } else {
    console.log(`[content] parsed ${yamlFiles.length} YAML files`);
  }
}

async function checkDistributionFacts(): Promise<void> {
  const packageReadme = await Bun.file(resolve(root, "packages/memware/README.md")).text();
  const requirements = [
    "Pre-release status",
    "not yet available from the public npm registry",
    "no public GitHub Release",
    "memware-darwin-arm64",
    "memware-linux-x64",
    "npx -y memware@latest serve",
    "[MIT License](LICENSE)",
    "Copyright (c) 2026 Memware",
  ];

  for (const requirement of requirements) {
    if (!packageReadme.includes(requirement)) {
      failures.push(`packages/memware/README.md: missing distribution fact ${JSON.stringify(requirement)}`);
    }
  }

  for (const readme of ["README.md", "README.zh-CN.md"]) {
    const source = await Bun.file(resolve(root, readme)).text();
    if (!source.startsWith("<!-- Generated from docs/content/readme-content.json")) {
      failures.push(`${readme}: missing generated-file marker`);
    }
    if (source.includes("docs_showcase.yml")) {
      failures.push(`${readme}: references retired docs_showcase.yml`);
    }
  }

  console.log("[content] checked distribution and entry-point facts");
}

async function checkLicense(): Promise<void> {
  const canonicalLicense = await Bun.file(resolve(root, "LICENSE")).text();
  const packageDirectories = [
    "packages/memware",
    "packages/memware-darwin-arm64",
    "packages/memware-linux-x64",
  ];

  if (!canonicalLicense.includes("Copyright (c) 2026 Memware")) {
    failures.push("LICENSE: missing product copyright attribution");
  }

  for (const directory of packageDirectories) {
    const packageLicense = await Bun.file(resolve(root, directory, "LICENSE")).text();
    if (packageLicense !== canonicalLicense) {
      failures.push(`${directory}/LICENSE: differs from the repository LICENSE`);
    }

    const manifest = await Bun.file(resolve(root, directory, "package.json")).json();
    if (manifest.license !== "MIT") {
      failures.push(`${directory}/package.json: license must be MIT`);
    }
  }

  const rootManifest = await Bun.file(resolve(root, "package.json")).json();
  if (rootManifest.license !== "MIT") {
    failures.push("package.json: license must be MIT");
  }

  console.log("[content] checked MIT license consistency");
}

const files = await collectFiles(root);
await checkMarkdownLinks(files);
checkYaml(files.filter((file) => repositoryRelative(file).startsWith(".github/")));
await checkDistributionFacts();
await checkLicense();

if (failures.length > 0) {
  for (const failure of failures) console.error(`[content] FAIL ${failure}`);
  process.exit(1);
}

console.log("[content] all checks passed");
