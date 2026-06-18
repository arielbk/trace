# Trace — Domain Context

Shared vocabulary for the Trace codebase. Use these terms exactly in code,
docs, and architecture reviews so names stay consistent.

## Core domain

- **Task** — a unit of work you pick up and put down. Has a slug, title,
  optional project root, registered sessions, and a docs directory.
- **Session** — one agent run (Claude Code, Codex, or Cursor) recorded against a
  task. Carries a tool, id, transcript path, model, and token totals.
- **Re-entry manifest** — the bundle a fresh session reloads to resume a task:
  the task, its docs, the distilled `state.md`, and pointers to prior sessions
  (newest first).
- **Token Totals** — the value module owning token arithmetic (`empty`, `add`,
  `fromUsage`); consumed by adapters and the store instead of per-call copies.

## Session lineage & attribution

- **origin** — every Session is one of `root` (started directly), `subagent` (an
  in-process agent of another session), or `spawned` (a separate CLI session
  launched by a host-side process). Stored on the session next to
  `parentSessionId`; defaults to `root`.
- **parentSessionId** — the nullable self-FK linking a child session to the
  session it descends from. **Tool-blind:** the link and the timeline's nested
  rendering key on the DB session id, not on which tool either end used — so a
  Codex child under a Claude parent nests the same as Claude-under-Claude.
- **Spawned child** — a *separate, top-level* CLI session launched by a host-side
  process (e.g. a Ralph loop running `claude -p` or `codex exec` per iteration).
  A full independent session with its own transcript; `origin='spawned'`.
- **In-process subagent** — within a *single* session, the Task tool (Claude) or
  `spawn_agent` (Codex) fans out to agents that write their own transcripts;
  `origin='subagent'`. Recovered post-hoc by a **discovery scanner** that reads
  the parent transcript's spawn records (Claude: the `Task` tool_use chain;
  Codex: `collab_agent_spawn_end`). Distinct from a Spawned child — a subagent is
  *inside* another run, not its own top-level session.
- **Attribution** — establishing a child session's `parentSessionId`/`origin`.
  The mechanism for **Spawned children** is in design (converging on
  "spawner captures the child id and a caller sets the link," tool-agnostic across
  Claude and Codex — see the `attribute-subagent-and-spawned-child-sessions` task);
  **In-process subagents** are attributed by their discovery scanner.

## Tool integration seams

- **Transcript Adapter** — the one place that knows, per `SessionTool`, how to
  read session identity, model, token totals, and the message head/tail out of a
  transcript. Callers consult `getTranscriptAdapter(tool)` rather than importing
  per-tool free functions and re-branching on the tool string.
  (`packages/core/src/transcript-adapter.ts`)

- **Session Locator** — sibling to the Transcript Adapter: the per-`SessionTool`
  seam that answers "does this tool own the *live* session, and if so what is its
  id and transcript path?" from a process env (and, for Cursor, an injected
  cwd→composerId resolver). Consulted via `getSessionLocator(tool)` /
  `sessionLocatorsByPrecedence`. `inferSessionIdentity` is the orchestrator that
  asks locators in precedence order (codex → claude → cursor, claude as terminal
  default) and applies caller overrides. Keeps `@trace/core` filesystem-free —
  the Cursor store read is an injected callback consumed only by the cursor
  locator. *(In design — see `docs/deepen-session-identity-behind-a-sessionlocator-family/`.)*
