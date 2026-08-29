# memware 架构要点

本文记录 memware 分发面（`src/memware/`）的结构性事实。记忆内核（`src/agent/memory/`）是本仓唯一真源，avatanel 经 git 依赖的 `memware/memory/*` exports 子路径消费；分发面同理经 `memware/memware/*` 暴露。

## MCP 工具面（serve）

`src/memware/server.ts` 的 `createMemwareServer` 以 MCP stdio 暴露七工具：
memory_status / warmup / get_context / process / search / archive / reset。
入参在边界经 zod 校验一次后直达 `IMemoryService`（装配见 `src/memware/memoryRegistry.ts` 的 `createMemoryService`）。

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

配置只经 `MEMWARE_*` 环境变量注入（`src/memware/env.ts`），数据默认落 `~/.memware/<userId>/`
（`src/memware/paths.ts`），与 avatanel 的 `~/.avatanel/` 完全隔离；不复制内核
`DEFAULT_CONFIG` 的任何业务默认值。
