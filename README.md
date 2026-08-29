# memware

**Long-term memory for any MCP-compatible agent**, shipped as a self-contained
single-file binary. Point it at an OpenAI-compatible LLM endpoint and it
distills each conversation turn into durable, searchable memory of your user —
stored entirely on the local machine.

```sh
claude mcp add memware -e MEMWARE_API_KEY=sk-... -- npx -y memware serve
```

Full usage docs (the seven MCP tools, Claude Code Stop-hook automation,
environment variables, troubleshooting):
[`packages/memware/README.md`](packages/memware/README.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `src/memware/` | The CLI: `serve` (MCP stdio server) and `hook` (Claude Code Stop hook) modes |
| `src/agent/memory/` | The memory kernel (extraction, routing, storage, vector search) |
| `packages/memware/` | npm main package — dependency-free Node launcher + docs + templates |
| `packages/memware-<os>-<arch>/` | npm platform subpackages carrying the prebuilt binaries |
| `scripts/memware-build.ts` | Cross-platform `bun build --compile` matrix (`MEMWARE_TARGETS` is the single source of truth) |
| `scripts/memware-pack.ts` | npm tarball packing for the main + platform packages |
| `tests/memware/` | Protocol-level and hook-mode tests (Bun test) |

## Develop

Requires [Bun](https://bun.sh).

```sh
bun install
bun run test           # tests/memware
bun run typecheck      # tsc --noEmit
bun run memware:build  # compile darwin-arm64 + linux-x64 binaries into dist/memware/
bun run memware:pack   # write npm tarballs into dist/memware/
```

## Origin

The memory kernel was extracted from the avatanel project's local memory
system (`src/agent/memory`), decoupled so it runs with no avatanel source tree
and no Bun on the end user's machine.
