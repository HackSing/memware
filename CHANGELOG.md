# Changelog / 变更记录

This file records user-visible changes to memware. Version numbers follow [Semantic Versioning](https://semver.org/).

本文件记录 memware 的用户可感知变化，版本格式遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Fixed

- Intent routing: classify the per-turn intent-analysis timeout by the analyzer's own abort signal instead of the error's `name`, so provider SDK abort classes (e.g. openai `APIUserAbortError`) are logged as a single timeout line with elapsed/budget/model rather than as a failure with a stack dump; always clear the budget timer. / 意图路由：按分析器自身的 abort 信号而非错误 `name` 判定超时，供应商 SDK 的中止错误类（如 openai `APIUserAbortError`）现在记为一行含耗时/预算/模型的超时日志，而不是带堆栈的失败；预算计时器总是被清理。

### Changed

- Intent routing budget is now configurable (`model.intent_timeout_ms`, adapter option `intentTimeoutMs`) and its default is raised from 5 s to 10 s. Measured against the default SiliconFlow DeepSeek-V3.2 endpoint: p50 ≈ 2.2 s, max 2.8 s in isolation, yet ~20% of production turns exceeded 5 s and silently lost long-term memory retrieval. / 意图路由预算改为可配置（`model.intent_timeout_ms`，adapter 选项 `intentTimeoutMs`），默认从 5 秒提高到 10 秒：对默认 SiliconFlow DeepSeek-V3.2 端点实测 p50 ≈ 2.2 秒、单测最大 2.8 秒，但生产约 20% 轮次超过 5 秒并静默失去长期记忆检索。

### Added

- Document the upgrade path for both distribution eras: source-checkout updates (`git pull` → re-verify → rebuild; binary path unchanged so no re-registration; `~/.memware/` data untouched) and the future npm path, in the bilingual READMEs and the usage reference. / 写明两种分发形态的更新方式：源码 checkout 更新（拉取 → 复验 → 重构建，二进制路径不变无需重新注册，`~/.memware/` 数据不受影响）与未来 npm 路径，双语 README 与使用手册同步。
- Add deployment-selectable tenant capability providers: the CLI keeps `single-process-v1`, while authenticated downstream hosts can opt into `trusted-host-v1` with an injected security-context resolver, per-action authorizer, opaque tenant identities, isolated handles, bounded active-tenant capacity, and idle eviction. / 新增可按下游选择的租户能力提供者：CLI 继续默认 `single-process-v1`，已认证宿主可显式接入 `trusted-host-v1`，并注入安全上下文解析、逐操作授权、不透明租户身份、独立句柄、活动租户上限与空闲回收。

### Security

- In trusted multi-tenant mode, caller-supplied `userId` is only a compatibility assertion and never a tenant selector. Authorization completes before storage creation; issuer namespaces prevent same-name collisions; security context is snapshotted before asynchronous authorization; every lease releases in `finally`; reset, cache, database, vector, audit, and asset lifecycle remain tenant-scoped. / 在可信多租户模式下，调用方 `userId` 只作为兼容断言，不能选择租户；授权先于存储创建，签发方命名空间隔离同名租户，安全上下文在异步授权前完成快照，每个租约均通过 `finally` 释放，reset、缓存、数据库、向量、审计与资产生命周期保持租户级隔离。
- Bind every `serve` and `hook` process to exactly one trusted `MEMWARE_USER_ID`. The optional tool-level `userId` remains temporarily for protocol compatibility, but any value other than the bound tenant is rejected before storage or model access. / 每个 `serve` 与 `hook` 进程只绑定一个可信的 `MEMWARE_USER_ID`；工具级可选 `userId` 暂时保留用于协议兼容，但与绑定租户不一致的值会在访问存储或模型前被拒绝。
- Replace lossy raw-ID directory names with instance-salted HMAC tenant keys. Dot segments, separators, Unicode replacement aliases, truncation aliases, and case-folding differences can no longer escape or intentionally share a tenant path. / 用实例加盐的 HMAC 租户键替代有损原始 ID 目录名；点段、路径分隔符、Unicode 替换别名、截断别名与大小写折叠不再造成路径逃逸或租户目录碰撞。
- Redefine `memory_reset` as verified full tenant deletion. It drains in-flight work, closes cached services, removes the SQLite database and sidecars, vectors, audit logs, assets, relations, and caches, verifies live/staging paths are absent, and only then returns `ok: true`. / 将 `memory_reset` 明确定义为经过验证的完整租户删除：先排空在途操作、关闭缓存服务，再删除 SQLite 数据库及 sidecar、向量、审计日志、资产、关系和缓存；确认正式与暂存路径均不存在后才返回 `ok: true`。
- Add cross-process reset locks, operation markers, crash recovery, and generation fencing. Independent review found and closed the generation-handshake, live-marker recovery, and marker-cleanup race windows so a completed reset cannot be followed by reads from a stale SQLite handle. / 新增跨进程 reset lock、操作 marker、宕机恢复与 generation 栅栏；独立复核发现并关闭 generation 握手、活跃 marker 恢复及异常 marker 清理三个竞态窗口，确保重置完成后不能再通过旧 SQLite 句柄读取历史记忆。
- Stop serializing raw local `userId` and `sessionId` routing metadata into external extractor prompts while preserving conversation text and extraction behavior. / 外部抽取模型提示词不再序列化本地原始 `userId` 与 `sessionId` 路由元数据，同时保留业务正文和原有抽取能力。
- Enforce a `0077` process umask and tighten memware-owned directories/files to `0700`/`0600`. Audit files now use a trusted local date and refuse symlinked date targets. / 进程统一使用 `0077` umask，并将 memware 自有目录与文件收紧为 `0700`/`0600`；审计文件使用可信本地日期命名，并拒绝日期文件符号链接目标。
- Migrate the legacy `<dataDir>/<lossy-userId>/` layout only when stored IDs prove exclusive ownership by the bound tenant. Ambiguous aliases, missing ownership evidence, mixed tenants, symlinks, and simultaneous old/new layouts fail closed without moving data. / 旧版 `<dataDir>/<有损-userId>/` 布局仅在库内 ID 能证明数据完全属于当前绑定租户时迁移；目录别名、归属证据缺失、混租户、符号链接或新旧布局并存都会安全拒绝，且不移动原数据。
- Sanitize `memory_status`: report boundary/layout/permission/reset state and endpoint origins without exposing the raw tenant ID, absolute data paths, salt, or key material. / 收紧 `memory_status`：只报告边界、布局、权限、重置状态与 endpoint origin，不再暴露原始租户 ID、绝对数据路径、盐或密钥材料。
- Add deterministic security regression coverage for all six tenant-aware tools, path collision/escape, legacy migration, complete reset, cross-process stale handles, reset recovery races, trusted-host authorization and isolation, mutable-context and shutdown races, pool capacity, provider identifier redaction, audit symlinks, and private permissions. Final gates: `50 pass / 0 fail / 208 expectations`, typecheck, content checks, macOS/Linux builds, and three npm package tarballs. / 新增确定性安全回归，覆盖六个租户业务工具、路径碰撞/逃逸、旧数据迁移、完整重置、跨进程旧句柄、重置恢复竞态、可信宿主授权与隔离、可变上下文与关闭竞态、租户池容量、供应商标识脱敏、审计符号链接和私有权限；最终门禁为 `50 pass / 0 fail / 208 expectations`，并通过类型检查、内容检查、macOS/Linux 构建及三个 npm 包打包。

### Changed

- Security: stop discovering model configuration from the current project directory. memware now derives Chat and Embedding endpoints only from built-in defaults and explicit `MEMWARE_*` variables, requires a separate key for a different Embedding origin, and exposes only sanitized endpoint origins in `memory_status`. / 安全修复：停止从当前项目目录自动发现模型配置；Chat 与 Embedding 端点只来自内置默认值和用户显式设置的 `MEMWARE_*`，跨 origin 的 Embedding 必须使用独立 Key，`memory_status` 仅展示脱敏后的 endpoint origin。
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
