# Security Policy / 安全策略

## Supported versions / 支持范围

memware is currently pre-release. Only the latest `main` source and the `0.2.0` version it declares receive security fixes; no stable published version is supported yet, and there is no public npm package or GitHub Release to patch.

memware 当前处于预发布阶段。只有最新 `main` 源码及其声明的 `0.2.0` 版本会接收安全修复，暂时没有受支持的稳定发布版本，也没有可供修补的 npm 公开包或 GitHub Release。

## Report privately / 私密报告

Use [GitHub private vulnerability reporting](https://github.com/HackSing/memware/security/advisories/new). Do not open a public Issue for a vulnerability, exposed secret, real user memory, or private conversation.

请使用 [GitHub 私密漏洞报告](https://github.com/HackSing/memware/security/advisories/new)。不要为漏洞、泄露的密钥、真实用户记忆或私密对话创建公开 Issue。

Include the affected commit or version, environment, impact, minimal reproduction, and suggested mitigation when available. Redact all unrelated sensitive data. The maintainer will coordinate disclosure after the report is validated and a remediation path is available; no fixed response SLA is promised during pre-release.

请尽量提供受影响的 Commit 或版本、环境、影响、最小复现和缓解建议，并删除所有无关敏感信息。维护者会在问题确认并具备修复路径后协调披露；预发布阶段暂不承诺固定响应 SLA。

## Kernel service boundary / 内核服务边界

The stateless kernel service (`src/kernel/`, see [`contracts/kernel.v1.json`](contracts/kernel.v1.json)) is the only memware surface meant to be deployed away from the user's machine. Its boundary:

- **The Bearer token is mandatory.** `MEMWARE_KERNEL_TOKEN` must be at least 16 characters or the service refuses to start, and every endpoint requires `Authorization: Bearer <token>`.
- **`GET /health` is the only unauthenticated endpoint**, because container and Kubernetes probes must call it without a credential. Its body carries versions and model names only — no credential, no memory data.
- **The container image binds `0.0.0.0`.** The published `Dockerfile` sets `MEMWARE_KERNEL_HOST=0.0.0.0` so the port is reachable inside the container, so run it on a trusted network or behind a reverse proxy and never expose it directly to the public internet.
- **Nothing is persisted.** The kernel keeps no state and never reads `MEMWARE_DATA_DIR` or `MEMWARE_USER_ID`: it cannot touch a user's on-disk memory, and a compromised instance exposes no stored memory.
- **Secrets are injected through the environment.** Model keys and the Bearer token are never baked into the image or written to disk.
- **Logs carry no content.** Each request logs one line — method, path, status, duration, item count, request id — never conversation text, memory content, query text, `userId` or the token.

无状态内核服务（`src/kernel/`，契约见 [`contracts/kernel.v1.json`](contracts/kernel.v1.json)）是 memware 唯一设计为可部署在用户设备之外的接口，其安全边界如下：

- **Bearer token 必填。** `MEMWARE_KERNEL_TOKEN` 至少 16 字符，否则服务拒绝启动；所有端点都要求 `Authorization: Bearer <token>`。
- **`GET /health` 是唯一免鉴权端点**，因为容器与 Kubernetes 探针必须无凭据调用；返回体只含版本与模型名，不含凭据与任何记忆数据。
- **镜像内绑定 `0.0.0.0`。** 发布的 `Dockerfile` 设置 `MEMWARE_KERNEL_HOST=0.0.0.0` 以便容器内端口可达，因此必须部署在可信网络或反向代理之后，不要直接暴露到公网。
- **不持久化任何数据。** 内核不持有状态，也不读 `MEMWARE_DATA_DIR` 与 `MEMWARE_USER_ID`：它无法触碰用户本地记忆，实例被攻破也不会泄露已存储的记忆。
- **密钥经环境变量注入**，不写入镜像，也不落盘。
- **日志不含正文。** 每个请求只记一行 method / path / status / 耗时 / items / requestId，对话正文、记忆正文、查询文本、`userId` 与 token 永不入日志。
