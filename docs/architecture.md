# memware 架构要点

本文记录 memware 分发面（`src/memware/`）的结构性事实。记忆内核（`src/agent/memory/`）是本仓唯一真源，avatanel 经 git 依赖的 `memware/memory/*` exports 子路径消费；分发面同理经 `memware/memware/*` 暴露。

## MCP 工具面（serve）

`src/memware/server.ts` 的 `createMemwareServer` 以 MCP stdio 暴露七工具：
memory_status / warmup / get_context / process / search / archive / reset。
入参在边界经 zod 校验后，先经过 `TenantProvider` 选择部署边界，再由 `TenantMemoryHandle` 的能力校验
与操作闸门进入 `IMemoryService`。调用方不能用 `userId` 切换租户。

`src/memware/tenantProvider.ts` 提供两种显式模式：

- `SingleTenantProvider`（`single-process-v1`）是 CLI serve/hook 的默认值，一个进程只绑定
  `MEMWARE_USER_ID`；
- `TrustedMultiTenantProvider`（`trusted-host-v1`）供 Avatanel 等已完成认证的下游宿主嵌入。宿主必须
  注入 `RequestSecurityContext` 与逐操作授权器；`issuer + tenantId` 经实例盐 HMAC 派生为不透明租户键，
  原始身份不会进入路径或内核行。

多租户模式下，工具参数中的 `userId` 仅是向后兼容的一致性断言，最终租户只能由服务端认证上下文
确定。`createMemwareServer` 在 trusted-host 模式缺少 `resolveSecurityContext` 时拒绝构造；认证缺失、授权
拒绝或断言不一致时均在创建租户存储前失败关闭。租户句柄池按租户隔离 Registry、SQLite、向量、审计、
资产与 reset 生命周期，并通过最大活动租户数、租约计数、空闲回收约束资源。

## 唯一写路径

serve 与 hook 共用的唯一写路径是 `src/memware/processTurn.ts` 的 `processTurn`：直接组合内核的
`UnifiedExtractor + routeUnifiedExtraction`（workspace/pendingWriter 恒 null），audit 落
`MEMWARE_DATA_DIR`。刻意不调用内核 runner `runUnifiedTurnExtraction`——其 workspace=null 时
audit 目录硬编码为 `~/.avatanel/.unified-extraction-log`，会破坏 memware 的数据自包含。

## hook 模式

`src/memware/hook.ts` 读 stdin 的 Claude Code Stop hook JSON（`transcript_path`），
`extractLastTurn`（`src/memware/transcript.ts`）解析 transcript 取最后一轮对话写库。
任何失败只落 stderr 并 `exit 0`，绝不阻断宿主。

末轮解析本身零运行时依赖，汇出在 `src/memware/adapters.ts`（`memware/adapters` 导出入口）：
`LastTurn`、`extractLastTurn` / `extractClaudeCodeLastTurn`、`extractCodexLastTurn`、
`extractCodexTurnFromPayload`、`TranscriptAdapter`、`getAdapter`，以及纯函数
`resolveHookTurn(agentId, hook, readFile = readFileSync)`——文件读取由参数注入，宿主可接自己的
会话来源。`hook.ts` 自身消费该入口，采集逻辑只有一份实现。

## 内核服务（无状态）

`src/kernel/` 是与本地产品并行的第二个入口：部署在后端旁、只算不存的 HTTP 服务，供服务端做记忆
提炼、向量化与检索（契约真源 `contracts/kernel.v1.json`）。

- 端点：`GET /health`、`POST /extract`、`POST /embed`、`POST /search`。除 `GET /health` 外都要求
  `Authorization: Bearer <MEMWARE_KERNEL_TOKEN>`；`/health` 是**唯一免鉴权端点**（容器与 k8s 探针需要
  无凭据调用），返回体只含版本与模型名，不含密钥与任何记忆数据。响应统一带 `x-request-id`；错误体
  统一 `{ error: { code, message } }`，码与状态对照见契约文件。
- 提炼语义：专用中文提示词（`src/kernel/extractPrompt.ts`）直接产出契约形状——只提炼以用户本人为
  主语的 `preference` / `fact` / `conclusion`，他人只能成为实体候选。内核在模型返回后强制校验能校验
  的部分：`sourceRefs` 必须指向请求里真实存在的 `messageId`（否则整体 422），置信度低于
  `KERNEL_CONFIDENCE_THRESHOLDS` 的丢弃，`fingerprint = sha256(归一化正文)` 命中调用方抑制名单或
  批内重复的丢弃，实体名按 `knownEntities` 的 canonicalName / aliases 归一。提示词或输出 schema 变化
  必须同步升级 `extractorVersion`（`src/kernel/version.ts`），服务端据此决定是否重提炼。
- 环境变量：`MEMWARE_KERNEL_TOKEN`（必填，≥ 16 字符）、`MEMWARE_KERNEL_HOST`（默认 `127.0.0.1`，
  镜像内为 `0.0.0.0`）、`MEMWARE_KERNEL_PORT`（默认 18971）、`MEMWARE_KERNEL_MAX_TEXTS`（默认 256）、
  `MEMWARE_KERNEL_MAX_CANDIDATES`（默认 2000）、`MEMWARE_KERNEL_TIMEOUT_MS`（默认 30000），以及模型
  通道 `MEMWARE_API_KEY` / `MEMWARE_BASE_URL` / `MEMWARE_MODEL` / `MEMWARE_EMBEDDING_*`（跨 origin
  必须给独立 key，规则与 `src/memware/env.ts` 一致）。
  内核不读 `MEMWARE_DATA_DIR` / `MEMWARE_USER_ID` / `MEMWARE_AGENT_ID`——它没有本地态。
- 隔离约束：`src/kernel/` 只依赖 `src/agent/memory/` 的纯模块（`llmClient`、`embedder`、`vectorMath`、
  `search` 的 `rerankScore`、`unified/thresholds`、`hardGateText`、`extractorNormalization`、`ids`）与
  `zod`；禁止 `bun:sqlite`、`@modelcontextprotocol/sdk` 与 `src/memware/*`。
  `tests/kernel/isolation.test.ts` 遍历 `src/kernel/main.ts` 的真实 import 图做断言。
- 容量保护：`/embed` 单次文本数超 `MEMWARE_KERNEL_MAX_TEXTS`、`/search` 候选数超
  `MEMWARE_KERNEL_MAX_CANDIDATES` 时返回 `payload_too_large`（413）；`/search` 的上限在向量化之前
  生效，排序复杂度 O(候选数 × 维度) 因此始终有界。
- 隐私：`userId` 只用于服务端隔离，不进提示词；每请求只记一行
  `method / path / status / 耗时 / items / requestId`，对话正文、记忆正文与 token 永不入日志。
- 构建与镜像：`bun run kernel:serve` 本地起服务；`bun run kernel:build`（`scripts/memware-build.ts
  --kernel`，复用 `MEMWARE_TARGETS` 平台矩阵，可用 `MEMWARE_BUILD_TARGETS` 取子集）产出
  `dist/kernel/memware-kernel-<target>`；仓根 `Dockerfile` 为两段式（`oven/bun:1` 编译 →
  `debian:bookworm-slim` 运行，非 root、`EXPOSE 18971`），`docker build -t memware-kernel .`。

## 分发产物

`scripts/memware-build.ts` 的 `MEMWARE_TARGETS`（darwin-arm64 / linux-x64 平台矩阵单一真源）
驱动 `bun build --compile` 产出单文件二进制；npm 主包 `memware` 的 `bin/launcher.js` 仅按
os/cpu 解析平台子包并 spawn 二进制，不用 postinstall（npm RFC 0054），解析失败显式 exit 1。

## 配置隔离

配置只经 `MEMWARE_*` 环境变量注入（`src/memware/env.ts`）。`MEMWARE_USER_ID` 在进程启动时绑定，
原始 ID 经实例盐 HMAC 派生为不可碰撞的 `tenantKey`，数据默认落
`~/.memware/tenants/<tenantKey>/`，与 avatanel 的 `~/.avatanel/` 完全隔离；不复制内核
`DEFAULT_CONFIG` 的任何业务默认值。无参 `MemorySettings` 只加载内置默认值，memware 不自动读取
项目目录中的 `memory-config.json` 或 `config/memory.json`；内核调用者如需文件配置，必须显式传入
绝对路径。Chat 与 Embedding 使用不同 origin 时必须分别提供凭据。

## 数据生命周期与权限

`TenantMemoryHandle` 使用控制目录中的操作标记、重置锁和 generation 栅栏协调长期 serve 与短期
hook 进程。`memory_reset` 先停止新操作、排空进行中的写入、关闭本进程句柄，再原子迁出并删除整个
租户根目录；删除回执写入成功后才返回 `ok: true`。其他进程下次操作时发现 generation 变化，必须
先关闭旧 SQLite 句柄，防止读取已删除记忆。启动阶段统一设置 `umask 0077`，memware 自有目录和文件
分别收紧为 `0700` 与 `0600`。

旧版 `<dataDir>/<lossy-userId>/` 目录只在数据库内所有 `user_id` 均等于当前绑定租户时迁移；碰撞、
混租户、符号链接或新旧布局并存都会拒绝启动。该策略优先避免误合并和误删除。

可信多租户身份由 `issuer` 命名空间隔离；同名 `tenantId` 来自不同签发方时会得到不同租户键。宿主
提供的安全上下文会在异步授权前复制并冻结，避免认证到使用之间因可变对象产生租户切换竞态。
