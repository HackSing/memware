import content from "../docs/content/readme-content.json";
import { resolve } from "node:path";

type Language = "en" | "zh";
type Localized = { en: string; zh: string };

const root = resolve(import.meta.dir, "..");
const mode = process.argv.includes("--write") ? "write" : "check";

function localize(value: Localized, language: Language): string {
  return value[language];
}

function render(language: Language): string {
  const zh = language === "zh";
  const lines: string[] = [];
  const add = (...values: string[]) => lines.push(...values);

  add(
    "<!-- Generated from docs/content/readme-content.json by scripts/render-readme.ts. Do not edit directly. -->",
    "",
    `# ${content.project}`,
    "",
    zh ? "[English](README.md)" : "[简体中文](README.zh-CN.md)",
    "",
    `**${localize(content.tagline, language)}**`,
    "",
    localize(content.summary, language),
    "",
    zh
      ? "> **项目状态：预发布。** 源码、测试与本地二进制构建已可用；npm 包和 GitHub Release 尚未公开发布。当前请使用下方的源码体验路径。`npx memware` 将在首次公开发布后可用。"
      : "> **Status: pre-release.** Source, tests, and local binary builds are available. The npm package and GitHub Release are not public yet, so use the source path below today. `npx memware` will become available with the first public release.",
    "",
    zh ? "## 为什么需要 memware" : "## Why memware",
    "",
  );

  for (const item of content.benefits) {
    add(`- **${localize(item.title, language)}**: ${localize(item.body, language)}`);
  }

  add(
    "",
    "```mermaid",
    "flowchart LR",
    zh ? "    A[用户与 Agent 对话] --> B[Stop Hook 自动捕获]" : "    A[User talks with an agent] --> B[Stop Hook captures the turn]",
    zh ? "    B --> C[提取长期事实与偏好]" : "    B --> C[Extract durable facts and preferences]",
    zh ? "    C --> D[(本地记忆库)]" : "    C --> D[(Local memory store)]",
    zh ? "    E[新的用户问题] --> F[MCP 按需召回]" : "    E[New user request] --> F[MCP recall on demand]",
    "    D --> F",
    zh ? "    F --> G[带历史上下文的回答]" : "    F --> G[Response grounded in prior context]",
    "```",
    "",
    zh ? "## 现在开始体验" : "## Try it today",
    "",
    zh
      ? "当前版本从源码运行，需要 [Bun](https://bun.sh)、Claude Code 和一个 OpenAI 兼容接口的 API Key。"
      : "The current source path requires [Bun](https://bun.sh), Claude Code, and an API key for an OpenAI-compatible endpoint.",
    "",
    zh ? "### 1. 克隆、校验并构建" : "### 1. Clone, verify, and build",
    "",
    "```sh",
    `git clone ${content.repository}.git`,
    `cd ${content.project}`,
    "bun install",
    "bun run test",
    "bun run typecheck",
    "bun run memware:build",
    "```",
    "",
    zh ? "### 2. 注册 MCP 服务" : "### 2. Register the MCP server",
    "",
  );

  for (const platform of content.platforms) {
    add(
      `${localize(platform.name, language)}:`,
      "",
      "```sh",
      "claude mcp add memware \\",
      "  -e MEMWARE_API_KEY=\"$MEMWARE_API_KEY\" \\",
      `  -- \"$PWD/dist/memware/${platform.binary}\" serve`,
      "```",
      "",
    );
  }

  add(
    zh
      ? "在 Claude Code 中调用 `memory_status` 验证服务状态。若使用自定义接口，还需配置 `MEMWARE_BASE_URL`、`MEMWARE_MODEL`、`MEMWARE_EMBEDDING_MODEL` 和对应的向量维度。独立 Embedding 接口使用 `MEMWARE_EMBEDDING_BASE_URL`；跨 origin 时必须同时提供 `MEMWARE_EMBEDDING_API_KEY`。"
      : "Call `memory_status` in Claude Code to verify the server. For a custom endpoint, also configure `MEMWARE_BASE_URL`, `MEMWARE_MODEL`, `MEMWARE_EMBEDDING_MODEL`, and the matching embedding dimension. Use `MEMWARE_EMBEDDING_BASE_URL` for a separate embedding endpoint and provide `MEMWARE_EMBEDDING_API_KEY` when it uses a different origin.",
    "",
    zh ? "### 3. 打开自动记忆" : "### 3. Enable automatic memory",
    "",
    zh
      ? "将 [`packages/memware/templates/claude-settings-hooks.json`](packages/memware/templates/claude-settings-hooks.json) 合并到 Claude Code 设置，并把 [`packages/memware/templates/claude-md-snippet.md`](packages/memware/templates/claude-md-snippet.md) 加入项目 `CLAUDE.md`。完整配置、7 个工具和故障排查见 [使用文档](packages/memware/README.md)。"
      : "Merge [`packages/memware/templates/claude-settings-hooks.json`](packages/memware/templates/claude-settings-hooks.json) into the Claude Code settings, then add [`packages/memware/templates/claude-md-snippet.md`](packages/memware/templates/claude-md-snippet.md) to the project's `CLAUDE.md`. See the [usage reference](packages/memware/README.md) for configuration, all seven tools, and troubleshooting.",
    "",
    zh ? "首次 npm 发布后，安装入口将简化为：" : "After the first npm release, installation will become:",
    "",
    "```sh",
    "claude mcp add memware -e MEMWARE_API_KEY=sk-... -- npx -y memware@latest serve",
    "```",
    "",
    zh ? "## 更新方式" : "## Updating",
    "",
    zh ? "源码安装（当前）：" : "Source install (current):",
    "",
    "```sh",
    `cd ${content.project}`,
    "git pull",
    "bun install",
    "bun run test && bun run typecheck",
    "bun run memware:build",
    "```",
    "",
    zh
      ? "重新构建会覆盖 MCP 注册指向的 `dist/memware/<平台>` 二进制，新的 Claude Code 会话自动使用新版本——无需重跑 `claude mcp add`，也无需改动 hook 配置。更新不会触碰 `~/.memware/` 下的记忆数据。拉取前先看 [更新日志](CHANGELOG.md) 了解变更；需要回退时 `git checkout <commit>` 后重新构建即可，数据目录不受影响。"
      : "Rebuilding overwrites the same `dist/memware/<platform>` binary your MCP registration points to, so new Claude Code sessions pick it up automatically — no need to re-run `claude mcp add` or change hook settings. Updates never touch the memory data under `~/.memware/`. Check the [Changelog](CHANGELOG.md) before pulling; to roll back, `git checkout <commit>` and rebuild — the data directory is unaffected.",
    "",
    zh
      ? "首次 npm 发布后：`npx -y memware@latest serve` 总是解析到最新发布版（需要稳定时可用 `memware@<版本号>` 锁定）。"
      : "After the first npm release, `npx -y memware@latest serve` always resolves the newest published version (pin with `memware@<version>` when you need stability).",
    "",
    zh ? "## 适合哪些场景" : "## Use cases",
    "",
    zh ? "| 场景 | 用户结果 |" : "| Use case | User result |",
    "| --- | --- |",
  );

  for (const item of content.useCases) {
    add(`| ${localize(item.name, language)} | ${localize(item.result, language)} |`);
  }

  add(
    "",
    zh
      ? "memware 不是聊天记录同步服务，也不代表原始对话只在本地处理：用于提取和向量化的正文仍会发送到你配置的模型接口，但本地 `userId` 和 `sessionId` 不会作为提示词元数据发送。请根据数据敏感度选择服务商和部署方式。"
      : "memware is not a chat-history sync service, and it does not mean conversation text stays entirely on-device. Text used for extraction and embeddings is sent to the model endpoint you configure, while local `userId` and `sessionId` routing metadata is omitted from provider prompts. Choose that provider and deployment according to the sensitivity of your data.",
    "",
    zh ? "## 产品边界" : "## Product boundaries",
    "",
    zh ? "| 已具备 | 暂未提供 |" : "| Available | Not yet available |",
    "| --- | --- |",
  );

  for (const item of content.boundaries) {
    add(`| ${localize(item.available, language)} | ${localize(item.notAvailable, language)} |`);
  }

  add("", zh ? "## 文档导航" : "## Documentation", "");
  for (const document of content.documents) {
    add(`- [${localize(document.label, language)}](${document.path}): ${localize(document.description, language)}`);
  }

  add(
    "",
    zh ? "## 参与和持续关注" : "## Participate and stay updated",
    "",
    zh ? "每个入口只处理一种任务：" : "Use the entry point that matches the task:",
    "",
    zh
      ? `- 遇到可复现问题，提交 [Bug](${content.repository}/issues/new?template=bug_report.yml)。`
      : `- Report a reproducible problem with the [Bug form](${content.repository}/issues/new?template=bug_report.yml).`,
    zh
      ? `- 有新的产品场景，提交 [Feature request](${content.repository}/issues/new?template=feature_request.yml)。`
      : `- Propose a new product outcome with the [Feature request form](${content.repository}/issues/new?template=feature_request.yml).`,
    zh
      ? `- 文档错误或缺失，提交 [Documentation report](${content.repository}/issues/new?template=documentation_report.yml)。`
      : `- Report missing or misleading docs with the [Documentation form](${content.repository}/issues/new?template=documentation_report.yml).`,
    zh
      ? `- 使用案例、教程和问答进入 [Discussions](${content.repository}/discussions)。`
      : `- Share use cases, tutorials, and questions in [Discussions](${content.repository}/discussions).`,
    zh
      ? `- 点击 GitHub 的 **Watch → Custom → Releases** 接收有意义的版本更新。`
      : `- Use GitHub **Watch → Custom → Releases** to receive meaningful release updates.`,
    "",
    zh ? "## 开发" : "## Development",
    "",
    zh ? "| 路径 | 职责 |" : "| Path | Responsibility |",
    "| --- | --- |",
  );

  for (const item of content.repositoryLayout) {
    add(`| \`${item.path}\` | ${localize(item.role, language)} |`);
  }

  add(
    "",
    "```sh",
    "bun run test",
    "bun run typecheck",
    "bun run content:check",
    "bun run memware:build",
    "bun run memware:pack",
    "```",
    "",
    zh
      ? `memware 是采用 [${content.license.name} 许可证](${content.license.path}) 的开源软件。${content.license.copyright}。`
      : `memware is open-source software licensed under the [${content.license.name} License](${content.license.path}). ${content.license.copyright}.`,
  );

  return `${lines.join("\n")}\n`;
}

const targets: Array<{ language: Language; path: string }> = [
  { language: "en", path: resolve(root, "README.md") },
  { language: "zh", path: resolve(root, "README.zh-CN.md") },
];

let failed = false;
for (const target of targets) {
  const expected = render(target.language);
  if (mode === "write") {
    await Bun.write(target.path, expected);
    console.log(`[readme] wrote ${target.path}`);
    continue;
  }

  const file = Bun.file(target.path);
  const actual = (await file.exists()) ? await file.text() : "";
  if (actual !== expected) {
    console.error(`[readme] out of date: ${target.path}`);
    failed = true;
  } else {
    console.log(`[readme] current: ${target.path}`);
  }
}

if (failed) {
  console.error("Run `bun run content:write` and commit both generated README files.");
  process.exit(1);
}
