# Changelog / 变更记录

This file records user-visible changes to memware. Version numbers follow [Semantic Versioning](https://semver.org/).

本文件记录 memware 的用户可感知变化，版本格式遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Changed

- 内核单一真源化：本仓成为记忆内核唯一真源。内核自包含改造——新增窄接口 `src/agent/memory/unified/sinks.ts`（`UnifiedWorkspaceSink`/`UnifiedPendingWriter`）与 `src/agent/memory/contentBlocks.ts`，切断对 avatanel `types/`、`evolution/`、`persona/`、`security/` 的引用（8 个外来文件删除）；`backgroundQueue.ts`、`unified/runMultimodalTurnExtraction.ts` 并入内核。avatanel 已切换为 git 依赖消费本仓（其内核副本删除）。
- 包名改为 `memware`，新增 exports 子路径：`memware/memory/*`（内核）与 `memware/memware/*`（分发面），消费方可以 git 依赖直接导入 TypeScript 真源（Bun + `moduleResolution: bundler` 实测通过；`private: true` 不影响 bun git 依赖安装）。
- 10 个内核测试自 avatanel `tests/unified-memory/` 迁入（迁移前后 266 条断言持平）；`bun test tests/unified-memory/ tests/memware/` 26 pass/0 fail，`tsc --noEmit` EXIT=0。
- Generate English and Chinese README files from one structured source with an idempotency check. / 从单一结构化事实源生成英文与中文 README，并增加幂等校验。
- Separate Issues, Discussions, and private security reporting, with bilingual contribution guidance. / 拆分 Issue、Discussions 与私密安全报告入口，补齐双语贡献规范。
- Add collectible, privacy-preserving metric snapshots and evidence-based content templates. / 新增可采集、保护隐私的指标快照和证据型内容模板。
- Add continuous content checks for bilingual output, links, YAML, and distribution claims. / 新增持续内容质量工作流，校验双语、链接、YAML 与分发口径。
- License memware under MIT with product-level copyright attribution and include the license in every npm package. / memware 采用 MIT 许可证和产品级版权标识，并确保所有 npm 包携带许可证。

## 0.1.0 - 2026-08-29（源码快照，尚未公开发布）

### Added / 新增

- Add `serve` MCP stdio and `hook` Claude Code Stop Hook modes. / 提供 `serve` MCP stdio 服务和 `hook` Claude Code Stop Hook 两种模式。
- Add seven memory tools for status, warmup, context, processing, search, archive, and reset. / 提供 7 个记忆工具，覆盖状态、预热、上下文、处理、搜索、归档与重置。
- Add local SQLite, vector storage, and extraction audit logs. / 支持本地 SQLite、向量存储和提取审计日志。
- Build self-contained binaries for Apple Silicon macOS and Linux x64. / 支持 Apple Silicon macOS 与 Linux x64 自包含二进制构建。
- Add the npm main package and platform optional-dependency packaging structure. / 提供 npm 主包与平台可选依赖的打包结构。
