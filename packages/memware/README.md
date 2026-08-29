# memware

**Long-term memory for any MCP-compatible agent.** memware is a portable memory
kernel shipped as a self-contained single-file binary: point it at an
OpenAI-compatible LLM endpoint and it distills each conversation turn into
durable, searchable memory of your user — stored entirely on the local machine.
The first target is [Claude Code](https://docs.claude.com/en/docs/claude-code),
but any [MCP](https://modelcontextprotocol.io) client can use it.

> **Pre-release status.** The source, tests, and local binary build are ready,
> but `memware` is not yet available from the public npm registry and there is
> no public GitHub Release. Use the source build below today. The `npx` command
> is the installation path for the first public release.

It runs in two modes:

- `memware serve` — an MCP stdio server exposing seven memory tools.
- `memware hook` — a Claude Code Stop hook that reads the transcript on stdin and
  persists the last turn automatically, so writing memory never depends on the
  model remembering to do it.

## The seven tools

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
| `memory_archive` | `userId?` | Archive stale memory clusters for the bound tenant. |
| `memory_reset` | `userId?` | Delete all database, vector, audit, asset, relation, cache, and sidecar artifacts for the bound tenant. |

> In an automated setup you rarely call `memory_process` yourself — the Stop hook
> does the writing. The read tools (`memory_warmup`, `memory_get_context`,
> `memory_search`) are what the model uses during a conversation.

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
(`memware-darwin-arm64` or `memware-linux-x64`). The `memware` command is a thin
Node launcher that resolves and runs it. **Do not install with `--omit=optional`
/ `--no-optional`** — that skips the platform binary and memware will not start.

### Manual binary (fallback)

If npm is unavailable, download the binary for your platform
(`memware-darwin-arm64` or `memware-linux-x64`) from the project's GitHub
Releases page, then point Claude Code at the local file:

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

Prebuilt binaries ship for **`darwin-arm64`** (Apple Silicon macOS) and
**`linux-x64`**. On any other platform the launcher fails loudly with the
supported list rather than silently degrading — it never runs a wrong-arch
binary. Windows is not yet supported.

## Troubleshooting

- **`unsupported platform "<os>-<arch>"`** — your OS/arch isn't in the prebuilt
  set (`darwin-arm64`, `linux-x64`). memware exits `1`; there is no binary to run.
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
