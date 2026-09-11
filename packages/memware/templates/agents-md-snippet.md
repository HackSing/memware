<!--
  memware — read-side + task-handoff instructions for non-Claude-Code agents
  (Codex AGENTS.md, Cursor rules, OpenCode, etc.).

  Copy the section below into the instruction file your agent reads
  (AGENTS.md for Codex, .cursor/rules or .cursorrules for Cursor, ...).
  Unlike Claude Code there is usually no Stop hook, so these instructions also
  cover the write side.
-->

## Long-term memory (memware)

You have a persistent, long-term memory of the user, served by the **memware**
MCP server. The same memory store is shared by all of the user's agents, so
anything another agent (Claude Code, Codex, ...) learned about the user is
available here, and what you learn here is available to them.

### Reading (always)

1. **At the start of a conversation or task**, call `memory_warmup` once.
2. **Before answering anything that depends on the user's personal facts,
   preferences, or history**, call `memory_get_context` with the user's
   question as `query` and ground your answer in what it returns.
3. **To actively recall something specific**, call `memory_search` with a
   focused query.
4. **When continuing or resuming ongoing work** — the user says "继续",
   "接着做", "continue", or references an unfinished task — call
   `memory_resume` first. It lists active task threads (including which agent
   touched them last and the recorded next step) plus related memories.
   Start from that briefing instead of asking the user to re-explain.

### Writing (when no automatic hook is configured)

If this agent has no memware Stop hook configured, record finished turns
yourself:

- **At the end of a meaningful exchange** (a decision was made, a fact about
  the user emerged, a task changed state), call `memory_process` with
  `sessionId` (a stable id for this session), `turnIndex` (0-based count of
  the user turns so far), `userMessage` and `assistantMessage`.
- **When a task you are working on reaches a milestone or pauses**, make sure
  the last processed turn states the concrete next step, so another agent can
  pick the work up via `memory_resume`.
- Do not record trivia (small talk, transient emotions) — the extractor
  filters aggressively, but don't feed it noise.
