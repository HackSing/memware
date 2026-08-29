<!--
  memware — read-side instructions for the model.

  Copy the section below into your project's CLAUDE.md (or any system prompt /
  agent instructions the model reads). It tells the model when to reach for
  memware's read tools. Writing is automated by the Stop hook, so the model is
  told NOT to call memory_process itself.
-->

## Long-term memory (memware)

You have a persistent, long-term memory of the user, served by the **memware**
MCP server. Use its read tools proactively — the user should never have to
repeat themselves:

1. **At the start of a conversation**, call `memory_warmup` once so the user's
   memory profile is loaded and ready.
2. **Before answering anything that depends on the user's personal facts,
   preferences, or history** — their name, projects, past decisions, tastes, or
   ongoing work — call `memory_get_context` with the user's question as `query`,
   and ground your answer in what it returns.
3. **When you need to actively recall something specific** that the current
   context doesn't cover, call `memory_search` with a focused query.

You do **not** need to record anything yourself. New turns are captured
automatically by the memware Stop hook, so do **not** call `memory_process` by
hand.
