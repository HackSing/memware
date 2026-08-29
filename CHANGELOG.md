# Changelog

本文件记录 memware 的用户可感知变化。版本格式遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Changed

- 内核单一真源化：本仓成为记忆内核唯一真源。内核自包含改造——新增窄接口 `src/agent/memory/unified/sinks.ts`（`UnifiedWorkspaceSink`/`UnifiedPendingWriter`）与 `src/agent/memory/contentBlocks.ts`，切断对 avatanel `types/`、`evolution/`、`persona/`、`security/` 的引用（8 个外来文件删除）；`backgroundQueue.ts`、`unified/runMultimodalTurnExtraction.ts` 并入内核。avatanel 已切换为 git 依赖消费本仓（其内核副本删除）。
- 包名改为 `memware`，新增 exports 子路径：`memware/memory/*`（内核）与 `memware/memware/*`（分发面），消费方可以 git 依赖直接导入 TypeScript 真源（Bun + `moduleResolution: bundler` 实测通过；`private: true` 不影响 bun git 依赖安装）。
- 10 个内核测试自 avatanel `tests/unified-memory/` 迁入（迁移前后 266 条断言持平）；`bun test tests/unified-memory/ tests/memware/` 26 pass/0 fail，`tsc --noEmit` EXIT=0。
- 重构 GitHub 首页，明确预发布状态、当前可用的源码体验路径和产品边界。
- 新增 Issue、PR、贡献、发布内容与内容运营模板。

## 0.1.0 - 2026-08-29（源码快照，尚未公开发布）

### Added

- 提供 `serve` MCP stdio 服务和 `hook` Claude Code Stop Hook 两种模式。
- 提供 7 个记忆工具，覆盖状态、预热、上下文、处理、搜索、归档与重置。
- 支持本地 SQLite、向量存储和提取审计日志。
- 支持 Apple Silicon macOS 与 Linux x64 自包含二进制构建。
- 提供 npm 主包与平台可选依赖的打包结构。
