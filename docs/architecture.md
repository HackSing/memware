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
