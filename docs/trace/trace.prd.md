# PRD: Trace

## Resources

- **Codex App Server** — JSON API surface that lists active sessions with IDs and event streams; what the official VS Code/JetBrains extensions build on. https://developers.openai.com/codex/app-server
- **Codex non-interactive mode** — `codex exec --json` emits JSONL events including `thread.started` (thread ID) and `turn.completed` (token usage). https://developers.openai.com/codex/noninteractive
- **Codex config reference** — https://developers.openai.com/codex/config-reference
- **Codex `CODEX_THREAD_ID`** — env var exposed inside a running session (shipped via openai/codex PR #10096, issue #8923). Confirmed live on local v0.133.0.
- **v1 reference**: the `aitrace` monorepo (`@arielbk/trace`) — a Next.js + CLI + Postgres transcript-analysis tool. Trace v2 reuses concepts but is a pivot, not an increment. No MCP server.

## Problem Statement

AI coding work is scattered and illegible. A single task gets worked on across multiple sessions and multiple tools (Claude Code, Codex), and afterward there's no single place to see what actually happened — which sessions belonged to a task, what docs (specs, plans) were produced for it, and what it cost in tokens. When a new session starts, the prior context is lost, so the user can't easily understand the history of a task or pick it back up.

## Solution

A **local, read-only Trace** built around one core unit: the **task**. A task is a first-class entity created via the Trace CLI (fronted by an agent skill so the human never types commands). Sessions from Claude Code and Codex are registered as **unassigned** the moment they start, then **explicitly assigned** to exactly one task. Everything a session touched — its transcript, the docs it produced, its token usage — rolls up to the task because the session is the join key. The user understands what happened two ways: an agent-facing CLI that emits a task's structured timeline, and a zero-design, read-only web view for humans.

The guiding constraint: **one session = one task.** This keeps context clean and makes the session the single point of association — no fuzzy per-artifact correlation needed.

## User Stories

1. As a developer, I want to tell an agent "we're working on the checkout task" and have it create/register a Trace task in the background, so that I don't manage task identity by hand.
2. As a developer, I want every Claude Code session to be registered in Trace the instant it starts, so that no work goes untracked.
3. As a developer, I want every Codex session to be registered in Trace too, so that cross-tool work lands in one place.
4. As a developer, I want a session to be explicitly assigned to exactly one task, so that the timeline stays clean and unambiguous.
5. As a developer, I want sessions that were never assigned to sit in a visible "unassigned" pile, so that I can triage or ignore them rather than lose them.
6. As a developer, I want a task's specs and plans (e.g. from `spec`/`slice` skills) associated with the task, so that the distillation of what matters travels with the task.
7. As a developer, I want to start a new chat, re-enter a task via the skill, and receive that task's associated docs and prior-session references as context, so that I can resume with the relevant material in hand.
8. As a developer, I want to see a task's token usage where it's freely available, so that I have a rough sense of cost without per-tool pricing work.
9. As a developer, I want the CLI to print a task's timeline (sessions across tools, docs, tokens, timestamps), so that an agent or I can read the history as structured output.
10. As a developer, I want a minimal read-only web view of a task's timeline, so that I can skim what happened without reading raw CLI output.
11. As a developer, I want to add a new tool adapter later without reworking the core, so that Cursor/Copilot can be added when ready.

## Implementation Decisions

**Adapter abstraction (deep module).** A per-tool ingestion interface that turns tool-native session storage into Trace's unified session records. Two adapters ship in v1:
- **Claude Code — push.** A `SessionStart` hook registers the session (ID + transcript path) as unassigned the moment it starts. Additional hooks (`Stop`/`SessionEnd`) capture end-of-session token totals. The in-session skill knows the live session ID, enabling in-session assignment.
- **Codex — push + backfill.** A Codex-side skill reads `$CODEX_THREAD_ID` at runtime and calls the Trace CLI to register/bind the session in-session (symmetric with Claude Code). A **filesystem scan** of `~/.codex/sessions/` + `~/.codex/session_index.jsonl` is the backfill path for sessions never bound live. The `thread_id` is identical across the env var, the `--json` `thread.started` event, and the rollout filenames — so no ID reconciliation is needed. Token usage comes from the `turn.completed` `usage` field.

The adapter interface is the seam that keeps Cursor/Copilot addable later without touching the core.

**Task / assignment store (deep module).** The core data model and the only writer of task state. Entities: **task** (first-class, created via CLI), **session** (registered unassigned, then assigned), and **doc associations** (task-scoped specs/plans). Enforces the invariant **one session ↦ at most one task**. Assignment is an explicit action (no automatic inference in v1). Local embedded storage (SQLite is the natural fit for a local tool; see Open Questions).

**Timeline rollup (deep module).** Given a task, aggregates its assigned sessions (both tools), associated docs, token totals, and timestamps into one ordered view. Pure read/query layer — consumed by both the CLI and the web view. Because the session is the join key, rollup walks session→task plus what's already inside each transcript; it does not re-store diffs or reconstruct file state.

**CLI.** Agent-facing commands: create a task, assign a session to a task, list tasks, show a task's timeline (structured output), list unassigned sessions. The CLI is the deliverable surface and the only write path for task/assignment state.

**Skill wrapper.** An agent-facing skill that wraps the CLI so the human speaks naturally ("we're working on X" / "re-enter task X") and the agent invokes the right commands — including in-session binding using the known Claude Code session ID or `$CODEX_THREAD_ID`.

**Read-only web view.** Zero-design, list → detail: tasks list; click a task → its timeline (sessions, docs, tokens). No editing, no auth, no filtering UI, no interactivity beyond navigation. The UI never writes — all creation/association goes through the CLI/skill.

**Re-entry (lightweight).** Re-entering a task hands the next agent the **references** (associated docs + prior-session summaries/pointers). It does not reconstruct live state or auto-continue work.

## Testing Decisions

All four core modules are tested. Good tests here exercise real session fixtures and the core invariant rather than mocks of internal state.

- **Session adapters** — feed recorded fixture transcripts (real Claude Code JSONL; real Codex rollout JSONL + a captured `--json` event stream) through each adapter and assert the produced session records (ID, transcript path, token usage). This is the most bug-prone area (format parsing), so it gets the most fixture coverage. Confirmed-real ID behavior to assert: `$CODEX_THREAD_ID` == `thread.started` ID == rollout filename ID.
- **Task / assignment store** — assert the **one session = one task** invariant (re-assigning moves rather than duplicates; a session can't be in two tasks), the unassigned→assigned lifecycle, and doc association. Core data integrity, so prioritize edge cases.
- **Timeline rollup** — given a task with sessions across both tools plus docs and token data, assert the aggregated, correctly-ordered view. Cover the empty task and the unassigned pile.
- **CLI commands** — end-to-end: create → register session → assign → show, and the unassigned-list path. Integration-level, driving the real store.

## Out of Scope

- **Handoff / auto-continue** — reconstructing live state so a *different* tool's agent resumes coherently without a human. (Lightweight reference-passing on re-entry *is* in scope; automatic continuation is not.)
- **Automatic task inference** — guessing which task a session belongs to. Assignment is explicit only in v1.
- **Cursor and Copilot adapters** — deferred; the adapter abstraction must accommodate them, but they aren't built.
- **Dollar-cost normalization** — no per-tool pricing tables or cross-tool dollar figures. Tokens only, where freely available; otherwise show "—".
- **AI summarization** — v1 is structured-raw (facts: sessions, docs, tokens, timestamps). No LLM in the loop, no OpenRouter dependency. Deferred as the first enhancement.
- **Worktree-as-task binding** — a worktree can host multiple tasks, so it's at most a hint, never the binding key.
- **A writing/interactive dashboard** — the web view is read-only; design polish, filtering, and editing are out.

## Open Questions

- **Doc association mechanism**: how docs get tied to a task — does the in-session skill stamp/record them as they're produced, or are they associated at assignment time by reading what the session touched? (Leaning: recorded via the skill during the session, since the session is already the join key.)

## Addendum: Tech Stack

Decided by comparison with the user's existing `pmdr` CLI (same author, same conventions). Trace inherits pmdr's monorepo DNA, diverges only where its domain demands it.

**Shared with pmdr (adopt wholesale for consistency):**
- **Turborepo + pnpm workspaces** (`apps/*`, `packages/*`).
- **TypeScript + ESM**, prettier, and the shared `@repo/eslint-config` / `@repo/typescript-config` packages.
- **tsup** to build and **vitest** to test. (Note: deliberately *not* following v1 `aitrace`'s Jest/Next setup — pmdr's lighter toolchain wins for a fresh repo.)

**Divergences (justified by Trace's domain):**
- **CLI rendering**: plain arg parser (cac/commander) + `--json`-first structured output. *No Ink* — pmdr needs a TUI for its live countdown; Trace's CLI is agent-facing command/query and doesn't.
- **Storage**: **SQLite (WAL) + Drizzle + `better-sqlite3`**, behind a swappable store interface in `packages/core`. pmdr's hand-rolled JSONL suits a single-writer timer; Trace needs safe concurrent writers (hook, Codex skill, scan) and relational joins for the rollup.
- **Web view**: **Vite + React**, reusing `@repo/ui` where useful. Lighter than v1's Next.js, which is more than a zero-design read-only view needs.

**Token extraction note:** pmdr already depends on **`ccusage`** (a Claude Code token-usage reader). The `claude-code-adapter` slice should evaluate `ccusage` before hand-parsing JSONL for tokens — it may already do the job.
