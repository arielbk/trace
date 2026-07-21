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
- **In-process subagent** — within a *single* session, the Task tool
  (Claude, Cursor) or `spawn_agent` (Codex) fans out to agents that write their
  own transcripts; `origin='subagent'`. Recovered post-hoc by a per-tool
  **discovery scanner** (`discover<Tool>SubagentSessions`) reading that tool's
  spawn records: Claude correlates the `Task` tool_use chain, Codex reads the
  parent's `collab_agent_spawn_end` events (each child rollout also self-names
  its parent in `session_meta`), Cursor walks the chat's `subagents/` mirror
  dir and reads the child composer's `subagentInfo` (falling back to matching
  Task prompts). Triggers: Claude's SubagentStop hook fires live; Codex and
  Cursor link at **board read time** — `listSessionsForTask` piggybacks on the
  read-time refresh (Codex spawn records ride the parse for free; Cursor costs
  one readdir of the mirror dir) so children appear the moment anyone looks —
  plus, as redundant belts, during `session scan --codex`, the task re-entry
  sweep, and on demand via `trace session discover-subagents <id>`. Distinct
  from a Spawned child — a subagent is *inside* another run, not its own
  top-level session.
- **Attribution** — establishing a child session's `parentSessionId`/`origin`.
  The mechanism for **Spawned children** is in design (converging on
  "spawner captures the child id and a caller sets the link," tool-agnostic across
  Claude and Codex — see the `attribute-subagent-and-spawned-child-sessions` task);
  **In-process subagents** are attributed by their discovery scanner.

## Tool integration seams

- **Integration Target** — one supported agent tool paired with one user-level
  config root; this `(tool, root)` pair is the identity Trace registers,
  reconciles, and removes.
- **Integration Registry** — the machine-local record of the package manager
  owning the installed CLI and every registered Integration Target.
- **Reconciliation** — making every Trace-owned artifact for selected
  Integration Targets match the currently installed CLI package, after the
  complete target set passes guardrails.

- **Transcript Adapter** — the one place that knows, per `SessionTool`, how to
  read session identity, model, token totals, and the message head/tail out of a
  transcript. Callers consult `getTranscriptAdapter(tool)` rather than importing
  per-tool free functions and re-branching on the tool string.
  (`packages/core/src/transcript-adapter.ts`)

- **Tool Session Locator** — sibling to the Transcript Adapter: the
  per-`SessionTool` seam that answers "does this tool own the *live* session,
  and if so what is its id and transcript path?" from a process env (and, for
  Cursor, an injected cwd→session resolver). Consulted via
  `getSessionLocator(tool)` / `sessionLocatorsByPrecedence`.
  `inferSessionIdentity` is the orchestrator that asks locators in precedence
  order (codex → claude → cursor, claude as terminal default) and applies
  caller overrides. Keeps `@trace/core` filesystem-free — the Cursor store read
  is an injected callback consumed only by the cursor locator; the CLI wires
  the real resolver exactly once, in its identity composition root
  (`apps/cli/src/commands/identity.ts`). Not to be confused with
  `SessionLocator` (`session-locator.ts`), which finds a *persisted* Session in
  the store. (`packages/core/src/tool-locator.ts`)

- **Transcript Locator** — the string a Session's `transcriptPath` slot
  carries: either the absolute path of a real on-disk transcript, or — for
  sessions with no transcript file (Cursor GUI composers, Codex subagents) — a
  synthetic `<tool>:<id>` reference. Cursor locators split into two flavors,
  `composer` (state.vscdb) and `agent-transcript` (cursor-agent CLI JSONL).
  The convention — minting, recognition, flavor — has one owner; nothing else
  re-derives the string shape. The per-tool resume command
  (`resume-command.ts`) keys off it so the web board stays tool-blind.
  (`packages/core/src/transcript-locator.ts`)
