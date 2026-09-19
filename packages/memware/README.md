# memware

**Long-term memory for any MCP-compatible agent.** memware ships as a
self-contained single-file binary that stores memory on the local machine: point
it at an OpenAI-compatible LLM endpoint and it distills each conversation turn
into durable, searchable memory of your user. The first target is
[Claude Code](https://docs.claude.com/en/docs/claude-code), but any
[MCP](https://modelcontextprotocol.io) client can use it.

This document describes that **local memory binary**. The same repository also
builds a separate, **stateless kernel service** for backends that keep their own
storage and only want extraction, embedding and search over HTTP — that surface
stores nothing and is covered in
[Kernel service (stateless, for backends)](#kernel-service-stateless-for-backends).

> **Pre-release status.** The source, tests, and local binary build are ready at
> version `0.2.0`, but `memware` is
> not yet available from the public npm registry
> and there is no public GitHub Release. Use the source build below today. The
> `npx` command is the installation path for the first public release.

The local binary runs in three modes:

- `memware serve` — an MCP stdio server exposing eight memory tools.
- `memware hook` — a Stop-hook writer that persists the last turn automatically,
  so writing memory never depends on the model remembering to do it. Claude Code
  supplies a transcript path; Codex is supported via its inline `notify` payload.
- `memware http` — the same memory store over a loopback-only, token-gated HTTP
  API for agents and scripts that do not speak MCP.

## The eight tools

`memware serve` exposes these tools over MCP. The process is bound to exactly
one tenant from `MEMWARE_USER_ID` (or `default`). The optional `userId` fields
remain for protocol compatibility, but they may only be omitted or equal that
bound value; selecting another tenant is rejected.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `memory_status` | *(none)* | Report the sanitized security boundary, model endpoint origins, and memory runtime status. |
| `memory_warmup` | `userId?` | Ensure the bound tenant profile exists (idempotent). |
| `memory_get_context` | `userId?`, `query` | Retrieve memory context (a `system` + `context` text pair) relevant to a query. |
| `memory_process` | `userId?`, `sessionId`, `turnIndex`, `userMessage`, `assistantMessage` | Extract and persist memory from one conversation turn. |
| `memory_search` | `userId?`, `query`, `limit?` | Search the bound tenant's memory; returns matching `results` and `clusters`. |
| `memory_resume` | `userId?`, `topic?`, `limit?` | Cross-agent task handoff: active task threads (with the last agent that touched each), related memories, and a ready-to-read briefing. |
| `memory_archive` | `userId?` | Archive stale memory clusters for the bound tenant. |
| `memory_reset` | `userId?` | Delete all database, vector, audit, asset, relation, cache, and sidecar artifacts for the bound tenant. |

> In an automated setup you rarely call `memory_process` yourself — the Stop hook
> does the writing. The read tools (`memory_warmup`, `memory_get_context`,
> `memory_search`, `memory_resume`) are what the model uses during a conversation.

## Try from source today

This path requires [Bun](https://bun.sh):

```sh
git clone https://github.com/HackSing/memware.git
cd memware
bun install
bun run test
bun run typecheck
bun run memware:build
```

Register the binary that matches your platform:

```sh
# Apple Silicon macOS
claude mcp add memware -e MEMWARE_API_KEY="$MEMWARE_API_KEY" \
  -- "$PWD/dist/memware/memware-darwin-arm64" serve

# Linux x64
claude mcp add memware -e MEMWARE_API_KEY="$MEMWARE_API_KEY" \
  -- "$PWD/dist/memware/memware-linux-x64" serve
```

Call `memory_status` to confirm the server is available, then configure the
recommended Stop hook below.

## Install after the first npm release (Claude Code)

memware installs as a standard [MCP server](https://modelcontextprotocol.io) via
`npx`. One command registers it:

```sh
claude mcp add memware -e MEMWARE_API_KEY=sk-... -- npx -y memware@latest serve
```

The `memware` package carries no binary itself; the prebuilt executable for your
platform installs automatically as an `optionalDependencies` subpackage
(`memware-darwin-arm64`, `memware-linux-x64`, or `memware-windows-x64`). The
`memware` command is a thin
Node launcher that resolves and runs it. **Do not install with `--omit=optional`
/ `--no-optional`** — that skips the platform binary and memware will not start.

### Manual binary (fallback)

If npm is unavailable, download the binary for your platform
(`memware-darwin-arm64`, `memware-linux-x64`, or `memware-windows-x64.exe`) from
the project's GitHub Releases page, then point Claude Code at the local file:

```sh
chmod +x ./memware
# macOS only: browser downloads are quarantined by Gatekeeper. Clear the flag.
# (The npm channel does NOT trigger quarantine — this step is only for manual
# downloads.)
xattr -d com.apple.quarantine ./memware

claude mcp add memware -e MEMWARE_API_KEY=sk-... -- /absolute/path/to/memware serve
```

## Configuration

memware is configured **only** through `MEMWARE_*` environment variables — never
a config file. Pass them with `-e` on `claude mcp add` (for the `serve` process),
and export them in the environment Claude Code runs in (for the `hook` process —
see [Claude Code hooks](#claude-code-hooks-recommended)). Project-local
`memory-config.json` and `config/memory.json` files are deliberately ignored:
a repository must not be able to choose the endpoint that receives your API key
and conversation data.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MEMWARE_API_KEY` | **yes** | — | OpenAI-compatible API key, used for chat/extraction and, by default, embeddings on the same endpoint origin. |
| `MEMWARE_MODEL` | no | kernel default | Chat/extractor model that distills each turn. Unset falls back to the kernel default model — set it explicitly whenever you override `MEMWARE_BASE_URL`. |
| `MEMWARE_BASE_URL` | no | kernel default | OpenAI-compatible endpoint. |
| `MEMWARE_EMBEDDING_MODEL` | no | kernel default | Embedding model for semantic search. |
| `MEMWARE_EMBEDDING_DIM` | no | kernel default | Embedding vector dimension (positive integer). |
| `MEMWARE_EMBEDDING_BASE_URL` | no | chat endpoint | Optional separate OpenAI-compatible embedding endpoint. |
| `MEMWARE_EMBEDDING_API_KEY` | conditional | chat key | Required when the embedding endpoint uses a different origin; prevents sending the chat key to another service. |
| `MEMWARE_DATA_DIR` | no | `~/.memware` | Private storage root for the bound tenant and lifecycle metadata. |
| `MEMWARE_USER_ID` | no | `default` | Trusted tenant id bound for the lifetime of this serve or hook process. |
| `MEMWARE_DEBUG` | no | off | Set to `1` or `true` for verbose extraction diagnostics on stderr. |
| `MEMWARE_KERNEL_TOKEN` | kernel service only | — | **Required to start the kernel service** (min 16 chars, e.g. `openssl rand -hex 32`). Bearer credential for every kernel endpoint except `GET /health`. |
| `MEMWARE_KERNEL_HOST` | kernel service only | `127.0.0.1` | Kernel service bind address. The container image sets `0.0.0.0`. |
| `MEMWARE_KERNEL_PORT` | kernel service only | `18971` | Kernel service bind port. |
| `MEMWARE_KERNEL_MAX_TEXTS` | kernel service only | `256` | Maximum texts accepted by one `POST /embed`; above it the service returns `payload_too_large`. |
| `MEMWARE_KERNEL_MAX_CANDIDATES` | kernel service only | `2000` | Maximum candidate vectors accepted by one `POST /search`; enforced before embedding. |
| `MEMWARE_KERNEL_TIMEOUT_MS` | kernel service only | `30000` | Upstream model call budget for the kernel service. |

The `MEMWARE_KERNEL_*` variables configure the stateless
[kernel service](#kernel-service-stateless-for-backends) only; `serve`, `hook`,
and `http` ignore them. The kernel service in turn never reads
`MEMWARE_DATA_DIR` or `MEMWARE_USER_ID` — it has no local state to address.

**About the defaults.** memware never re-declares the memory kernel's own
defaults: any optional variable you leave unset simply falls through to the
kernel's built-in value. When `MEMWARE_BASE_URL` is unset, the kernel targets
[SiliconFlow](https://siliconflow.cn) (`https://api.siliconflow.cn/v1`); a
known-good pairing for that endpoint is `MEMWARE_MODEL=deepseek-ai/DeepSeek-V3.2`.
Point `MEMWARE_BASE_URL` / `MEMWARE_MODEL` / `MEMWARE_EMBEDDING_MODEL` at any
other OpenAI-compatible provider to use it instead.

Model endpoints must be explicit HTTP or HTTPS URLs, including LAN-hosted
OpenAI-compatible services. When Chat and Embedding use different origins,
configure `MEMWARE_EMBEDDING_API_KEY`
explicitly; memware fails before a network request rather than forwarding the
primary key to a different origin. Call `memory_status` to inspect the effective
endpoint origins and configuration source without exposing credentials.

## Claude Code hooks (recommended)

The read tools let the model *recall* memory, but something has to *write* it.
Rather than trust the model to call `memory_process` every turn, register a
**Stop hook** so Claude Code writes the last turn automatically when it finishes
responding. Merge this into `~/.claude/settings.json` (full template:
[`templates/claude-settings-hooks.json`](templates/claude-settings-hooks.json)):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y memware hook"
          }
        ]
      }
    ]
  }
}
```

Notes:

- The hook reads Claude Code's Stop-hook JSON on stdin (it carries the
  `transcript_path`), parses the final user/assistant turn, and writes it to the
  **process-bound tenant** (`MEMWARE_USER_ID`, or `default`).
- **The hook never blocks Claude Code.** Any failure — bad config, unreachable
  endpoint, unparseable transcript — is logged to stderr and the hook exits `0`.
  A dropped turn is silent; it never interrupts your session.
- The hook process needs `MEMWARE_API_KEY` in its environment. The `-e` flags
  on `claude mcp add` apply to the `serve` process only — for the hook,
  `export MEMWARE_API_KEY=...` in the shell profile that launches Claude Code
  (e.g. `~/.zshrc`). If you also override `MEMWARE_BASE_URL` / `MEMWARE_MODEL`,
  export those there too.

## Multi-agent setup (shared memory across agents)

All agents that point at the **same `MEMWARE_DATA_DIR` + `MEMWARE_USER_ID`**
share one memory store — anything one agent writes, every other agent can read.
Set `MEMWARE_AGENT_ID` per agent so provenance records which client learned
what (each write is stamped; `memory_resume` shows the last agent per task).

| Agent | MCP registration | Automatic writes | Read instructions |
| --- | --- | --- | --- |
| Claude Code | `claude mcp add ...` (above) | Stop hook (transcript file) | `templates/claude-md-snippet.md` → `CLAUDE.md` |
| Codex | `[mcp_servers.memware]` in `~/.codex/config.toml` | `notify` hook (inline payload) | `templates/agents-md-snippet.md` → `AGENTS.md` |
| Cursor | `.cursor/mcp.json` | none — instruction-driven | `templates/agents-md-snippet.md` → `.cursor/rules` |
| Any MCP client | standard stdio registration | none — instruction-driven | adapt the agents snippet |

### Codex (~/.codex/config.toml)

```toml
[mcp_servers.memware]
command = "/path/to/memware-linux-x64"
args = ["serve"]
env = { MEMWARE_API_KEY = "sk-...", MEMWARE_AGENT_ID = "codex" }

# automatic turn capture (inline payload — no transcript file needed)
notify = ["/path/to/memware-linux-x64", "hook"]
```

The Codex `notify` payload carries the finished turn inline
(`input-messages` / `last-assistant-message`); the hook detects the absence of
`transcript_path` and parses it directly. Same never-blocks guarantee as
Claude Code: failures log to stderr and exit `0`.

Two caveats specific to `notify`:

- **`notify` is a single slot.** Codex runs one notify program, so a config
  that already points at another tool cannot also run memware this way. Chain
  them from one wrapper script, or drive memware from a transcript-path host
  instead.
- **The payload has no session id**, only a per-turn `turn-id`. memware scopes
  each notify turn under `codex-turn-<id>` (index 0) rather than inventing a
  session boundary Codex never reported, so provenance and
  `deleteByProvenance` stay per-turn. Rollout files, which do carry a real
  `session_id` in their `session_meta` header, keep session-wide scope with
  ordinal turn indexes.

The notify process needs the same env exports as the Claude Code hook
(`MEMWARE_API_KEY`, optionally `MEMWARE_BASE_URL` / `MEMWARE_MODEL`,
`MEMWARE_DATA_DIR` / `MEMWARE_USER_ID` if non-default).

### Cursor (.cursor/mcp.json)

```json
{
  "mcpServers": {
    "memware": {
      "command": "/path/to/memware-linux-x64",
      "args": ["serve"],
      "env": { "MEMWARE_API_KEY": "sk-...", "MEMWARE_AGENT_ID": "cursor" }
    }
  }
}
```

Cursor has no Stop hook today, so writing is instruction-driven: paste
[`templates/agents-md-snippet.md`](templates/agents-md-snippet.md) into your
Cursor rules and the model calls `memory_process` at the end of meaningful
exchanges.

### Sharing vs isolation

Shared memory is the default: same data dir + same `MEMWARE_USER_ID` = one
memory store for all agents. To isolate an agent (e.g. work vs personal), give
it a different `MEMWARE_USER_ID` — each id maps to its own tenant tree under
`~/.memware/tenants/<opaque-key>/` and nothing crosses over.

## Local HTTP API (non-MCP agents)

`memware http` exposes the same memory store over HTTP for agents and scripts
that don't speak MCP:

```sh
export MEMWARE_HTTP_TOKEN=$(openssl rand -hex 32)
npx -y memware http
# [memware] http ready — http://127.0.0.1:18970 (loopback only, bearer token required)
```

Endpoints (all JSON; POST bodies unless noted):

| Endpoint | Body | Mirrors |
| --- | --- | --- |
| `GET /health` | — | `memory_status` (subset) |
| `POST /v1/process` | `sessionId`, `userMessage`, `assistantMessage`, `turnIndex?`, `agentId?` | `memory_process` |
| `POST /v1/context` | `query` | `memory_get_context` |
| `POST /v1/search` | `query`, `limit?` | `memory_search` |
| `POST /v1/resume` | `topic?`, `limit?` | `memory_resume` |

Security model — the API is local-only by construction:

- **Loopback binding enforced.** The server binds `127.0.0.1` (override with
  `MEMWARE_HTTP_HOST`, but only loopback addresses are accepted — a wider bind
  is refused at startup).
- **Bearer token required.** `MEMWARE_HTTP_TOKEN` (min 16 chars) must be set;
  without it the server refuses to start. Every request needs
  `Authorization: Bearer <token>`.
- **Same tenant boundary as stdio.** Requests cannot select a user/tenant; the
  optional `agentId` body field only stamps write provenance.

```sh
curl -s http://127.0.0.1:18970/v1/resume \
  -H "Authorization: Bearer $MEMWARE_HTTP_TOKEN" \
  -d '{"topic":"refactor"}'
```

## Kernel service (stateless, for backends)

Everything above stores memory on the user's machine. `src/kernel/` is a second,
independent entry point for the opposite deployment: a backend that already owns
its database and only wants memware's *computation* — extraction, embedding and
ranking — over HTTP. **It stores nothing.** No SQLite, no vectors, no audit log,
no tenant tree; it never reads `MEMWARE_DATA_DIR` or `MEMWARE_USER_ID`.

```sh
export MEMWARE_KERNEL_TOKEN=$(openssl rand -hex 32)
export MEMWARE_API_KEY=sk-...
bun run kernel:serve
# [memware-kernel] listening on http://127.0.0.1:18971 ...
```

| Endpoint | Auth | What it does |
| --- | --- | --- |
| `GET /health` | **none** | Liveness/readiness probe. Returns service version, `extractorVersion`, embedding model and declared dimension — never a credential, never memory data. |
| `POST /extract` | Bearer | Distill one conversation into facts about the user, entity candidates and edges, each with a content fingerprint and the `extractorVersion` that produced it. |
| `POST /embed` | Bearer | Embed up to `MEMWARE_KERNEL_MAX_TEXTS` texts in one call. |
| `POST /search` | Bearer | Rank caller-supplied candidate vectors against a query; the candidate ceiling is enforced before embedding. |

- **Bearer token is mandatory.** `MEMWARE_KERNEL_TOKEN` (min 16 chars) must be
  set or the service refuses to start, and every endpoint except `GET /health`
  requires `Authorization: Bearer <token>`. `GET /health` is the **only**
  unauthenticated path, because container and Kubernetes probes must call it
  without a credential.
- **Extraction semantics.** Only statements whose subject is the user become
  `preference` / `fact` / `conclusion`; other people can appear as entity
  candidates but never as facts of their own. Sources that are not in the
  request are rejected, low-confidence items and caller-suppressed fingerprints
  are dropped, and `extractorVersion` (currently `kernel-extract-v1`) is
  returned so the backend can decide when to re-extract.
- **Wire contract.** [`contracts/kernel.v1.json`](../../contracts/kernel.v1.json)
  is the source of truth for request/response shapes, error codes and statuses.
- **Dependency isolation.** The kernel imports only pure modules from
  `src/agent/memory/` plus `zod`; `bun:sqlite`, the MCP SDK and `src/memware/*`
  are forbidden and `tests/kernel/isolation.test.ts` walks the real import graph
  to assert it.
- **Privacy.** Each request logs exactly one line — method, path, status,
  duration, item count, request id. Conversation text, memory content, query
  text and the token never reach the log.

### Container

The repository-root [`Dockerfile`](../../Dockerfile) builds a two-stage image
(`oven/bun:1` compile → `debian:bookworm-slim` runtime, non-root, `EXPOSE 18971`):

```sh
docker build -t memware-kernel .

docker run --rm -p 18971:18971 \
  -e MEMWARE_KERNEL_TOKEN="$MEMWARE_KERNEL_TOKEN" \
  -e MEMWARE_API_KEY="$MEMWARE_API_KEY" \
  memware-kernel
```

The image contains no credentials and no memory data — everything is injected
through the environment at run time. Inside the container the service binds
`0.0.0.0`, so deploy it on a trusted network or behind a reverse proxy; the
Bearer token remains mandatory either way.

Standalone binaries build the same way as the local product:

```sh
bun run kernel:build   # → dist/kernel/memware-kernel-<target>
```

## Capture entry point (`memware/adapters`)

`memware/adapters` is a dependency-free export that turns an agent's Stop-hook
payload into the last finished turn — no storage, no MCP, no model client, no
environment. memware's own `hook` mode consumes it, so an embedder and memware
share one definition of "the last finished turn":

```ts
import { resolveHookTurn } from "memware/adapters";

const resolved = resolveHookTurn("claude-code", hookPayload);
if (resolved.turn) {
  // resolved.turn.userMessage / assistantMessage, resolved.sessionId
}
```

It also exports `LastTurn`, `TranscriptAdapter`, `getAdapter`,
`extractLastTurn` / `extractClaudeCodeLastTurn`, `extractCodexLastTurn`,
`extractCodexTurnFromPayload`, `extractCodexSessionId`,
`codexSessionIdFromPayload` and `fallbackSessionId`. `resolveHookTurn` takes an
optional third argument, the file reader, so a host with a virtual transcript
source never touches the real disk.

`resolveHookTurn` resolves the session id most-authoritative-first: the hook's
own `session_id`, then whatever the adapter derives from the source it just
parsed (`sessionIdFromTranscript` / `sessionIdFromHookPayload`), then
`fallbackSessionId(agentId)`. The fallback is a constant, and `(session_id,
turn_index)` is the provenance key `deleteByProvenance` scopes deletes to — so
an adapter for a host that does not supply a session id should derive one
rather than let every write of that agent share a single key.

## Teach the model to read (recommended)

A hook writes memory, but the model still has to *decide to read it*. Paste
[`templates/claude-md-snippet.md`](templates/claude-md-snippet.md) into your
project's `CLAUDE.md` (or any instructions the model sees). It tells the model
to `memory_warmup` at the start of a conversation, call `memory_get_context`
before answering questions that depend on the user's facts/preferences/history,
reach for `memory_search` when it needs to actively recall something, and *not*
to call `memory_process` by hand (the hook already does).

## Data & privacy

All memory lives on the local machine under `~/.memware/` (or `MEMWARE_DATA_DIR`).
Raw user ids never become path segments; an instance salt derives an opaque,
collision-resistant tenant key:

```
~/.memware/
├── .instance-salt        # private local salt; never sent to a provider
├── .control/<tenantKey>/ # reset lock, operation markers, generation fence
├── deletion-receipts/    # content-free reset receipts
└── tenants/<tenantKey>/
    ├── memory/
    │   ├── memory.db     # SQLite: facts, clusters, profile, graph metadata
    │   ├── vectors       # embedding vector database
    │   └── assets/       # captured local assets
    └── audit/            # extraction audit log
```

- **Local by default.** memware stores everything on disk here. The only data
  that leaves the machine is what any LLM app sends: each turn's text is sent to
  your configured OpenAI-compatible endpoint for extraction and embedding. Raw
  local `userId` and `sessionId` routing metadata is omitted from extractor
  prompts. Choose `MEMWARE_BASE_URL` accordingly.
- **Deployment-selected tenant boundary.** The CLI remains single-tenant: MCP
  callers cannot switch tenant by passing another `userId`, and separate local
  identities should use separate processes. Repository/Git source consumers can
  embed `TrustedMultiTenantProvider` behind an authenticated host. In that mode the
  host injects `RequestSecurityContext` and a per-action authorizer; caller
  `userId` is only an assertion, never authority. memware does not provide an
  identity provider, hosted gateway, or tenant admin console.
- **Private local files.** memware applies a `0077` process umask and tightens
  owned directories/files to `0700`/`0600`, including SQLite sidecars and JSONL.
- **Deletion = verified lifecycle.** `memory_reset` blocks new operations, drains
  in-flight work across serve/hook processes, closes stale handles through a
  generation fence, atomically detaches the tenant tree, deletes every owned
  artifact, and only then returns `ok: true`. A content-free receipt remains
  outside the tenant tree. `partial_failure` means deletion was not verified and
  normal operations remain blocked until recovery succeeds.
- **Legacy migration is fail-closed.** On first start, the old `<userId>/` layout
  is moved only when its database proves it belongs to the bound tenant. Ambiguous
  aliases, symlinks, mixed tenant data, or simultaneous old/new layouts stop
  startup for manual review instead of merging data.

## Upgrade / uninstall

**Upgrade from a source checkout (current pre-release path).** Pull, re-verify,
and rebuild in your clone:

```sh
cd memware
git pull
bun install
bun run test && bun run typecheck
bun run memware:build
```

The rebuild overwrites the same `dist/memware/<platform>` binary your
`claude mcp add` command points to, so new Claude Code sessions pick it up
automatically — no re-registration or hook changes needed. Your memory under
`~/.memware/` (or `MEMWARE_DATA_DIR`) is never touched by an upgrade. See the
[Changelog](../../CHANGELOG.md) for what changed; to roll back,
`git checkout <commit>` and rebuild.

**Upgrade once the npm package is public.** `npx` caches packages, so
`npx -y memware` can keep running an older cached version. To move to the
latest:

- Pin the version in your `claude mcp` command, e.g. `npx -y memware@latest serve`
  (re-run `claude mcp add` to update it), or
- clear the npx cache with `npx clear-npx-cache`, or
- if you installed memware globally, run `npm update -g memware`.

**Uninstall** (three steps):

1. `claude mcp remove memware` — unregister the MCP server.
2. Remove the memware Stop hook block from `~/.claude/settings.json`.
3. `npm uninstall -g memware` if you installed it globally (npx users have
   nothing to uninstall; optionally `npx clear-npx-cache`). Source-checkout
   users simply delete the clone. Delete `~/.memware`
   (or `MEMWARE_DATA_DIR`) to erase all stored memory.

## Platform support

Prebuilt binaries ship for **`darwin-arm64`** (Apple Silicon macOS),
**`linux-x64`**, and **`windows-x64`**. On any other platform the launcher
fails loudly with the supported list rather than silently degrading — it never
runs a wrong-arch binary.

Windows notes: run `memware` from a terminal with `npx`/npm on PATH; the Stop
hook works the same as on macOS/Linux, and `transcript_path` values with
Windows path separators are handled natively.

## Troubleshooting

- **`unsupported platform "<os>-<arch>"`** — your OS/arch isn't in the prebuilt
  set (`darwin-arm64`, `linux-x64`, `windows-x64`). memware exits `1`; there is
  no binary to run.
- **`platform package "memware-<platform>" is not installed`** — the platform
  subpackage was skipped, almost always because memware was installed with
  `--omit=optional` / `--no-optional`. Reinstall without those flags
  (`npm install memware`).
- **`MEMWARE_API_KEY is required`** — the key is unset or empty. `serve` exits `1`
  with this message. In hook mode the same misconfiguration is logged to stderr
  and the hook exits `0` (the turn is silently dropped, never blocking the host).
- **`MEMWARE_EMBEDDING_API_KEY is required`** — Chat and Embedding point to
  different origins. Supply a separate embedding key or use the same origin for
  both channels.
- **Extraction warning / no memory written** — when `MEMWARE_BASE_URL` is
  overridden but `MEMWARE_MODEL` is left unset, memware prints
  `MEMWARE_MODEL is unset while MEMWARE_BASE_URL overrides the default endpoint`
  on stderr: extraction then uses the built-in default model
  (`deepseek-ai/DeepSeek-V3.2`), which your endpoint may not serve. Set
  `MEMWARE_MODEL` to a model your endpoint actually hosts. With both unset, the
  built-in SiliconFlow pairing applies and no warning is printed.
- **Hook doesn't seem to fire** — the hook swallows all errors and exits `0`, so
  failures are invisible by default. Check that:
  1. `MEMWARE_API_KEY` is exported in the environment Claude Code runs in — the
     `-e` flags on `claude mcp add` do **not** reach the hook process.
  2. The Stop hook block in `~/.claude/settings.json` matches the template above.
  3. Run with `MEMWARE_DEBUG=1` and watch stderr — hook skips are logged as
     `[memware hook] skipped (<reason>)` with the underlying cause.

## License

memware is open-source software licensed under the [MIT License](LICENSE).
Copyright (c) 2026 Memware.
