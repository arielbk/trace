# PRD: Handoff Re-entry

## Problem Statement

When a working session ends — you hit a context limit, you `/clear`, or you jump
from Claude Code to Codex — the next agent starts cold. You re-explain what the
task is, what's already been decided, and what's left. That re-explaining is the
felt pain. It happens within the hour (session two arrives fast: a compaction, a
limit, a provider switch), and it happens *across tools*: a skill running inside
Claude Code cannot see what happened in a Codex thread, so today the only way to
carry context across that boundary is to paste it by hand.

Trace already captures the raw material — sessions are registered with live
transcript pointers, and docs can be associated with a task — but the `re-enter`
verb only prints a flat list of references. It doesn't deliver a picture a fresh
agent can act on, and the docs it points at live in the repo (`docs/{feature}/`),
which pollutes the repo, goes stale, and isn't reachable from a different
checkout or tool.

## Solution

Make re-entry the moment trace earns its keep: from **any** tool, the user says
"re-enter task X" and a fresh agent picks up the thread with **zero
re-explaining**.

The design is **pull, not push**. Nothing is triggered mid-session and nothing
is summarised when a session ends — capture stays free (just pointers, written
continuously to disk by the host tool). The "make sense of it" work happens once,
at re-entry, performed by the re-entering agent — the one that has a fresh
context budget and is spending it on purpose.

The re-entering agent consumes two things, in priority order:

1. **The task's decision-docs** (primary) — specs, plans, task DAGs, handoff
   notes. These are the distilled decisions and are high-signal and cheap.
2. **The most recent session's transcript tail** (fallback) — only when the docs
   don't yet cover the current state (e.g. a conversation that made decisions but
   hasn't produced a doc yet). Never the raw full transcript.

Decision-docs live in trace's own home — `~/.trace/tasks/<taskId>/docs/` — not
the repo. Writing a file into that directory *is* the association; nothing is
inferred. Because the directory is global, both a Claude session and a Codex
session reach the same docs regardless of which checkout or tool they run in —
which is what makes the cross-tool jump work.

The guiding invariant: **trace may be incomplete, never incorrect.** If an agent
never writes a doc, that doc is simply *missing* from the task and re-entry falls
back to the transcript — but nothing is ever *wrongly* attached.

## User Stories

1. As a developer who hit a context limit in Claude Code, I want to `/clear`,
   say "re-enter task X", and have the fresh agent already know the decisions and
   what's next, so that I never re-explain.
2. As a developer who wants to switch providers mid-task, I want to open Codex,
   say "re-enter task X", and have it pick up the thread from the Claude work,
   so that jumping tools costs me nothing.
3. As an agent re-entering a task, I want the decision-docs handed to me first
   and the transcript only as a fallback, so that I get high signal without
   drowning in raw conversation.
4. As an agent working a task, I want a known directory to write task docs into,
   so that the artifacts I produce are automatically carried with the task.
5. As an agent re-entering an in-flight task that has no doc yet, I want the tail
   of the most recent session's conversation, so that decisions made purely in
   chat aren't lost.
6. As a developer, I want trace docs to live outside my repo by default, so that
   implementation scaffolding doesn't become repo clutter I have to maintain or
   that goes stale against later changes.
7. As a developer, I want re-entry to degrade gracefully when something is
   missing (no docs, no transcript, an orphaned session), so that I get whatever
   context exists rather than an error.

## Implementation Decisions

### Task doc store

A deep module that resolves a task's doc directory — `~/.trace/tasks/<taskId>/docs/`
— from the trace home, reusing the same home/override resolution as the existing
DB path (`TRACE_DB`/`HOME` today; the doc dir derives from the same root).
Writing any file into that directory associates it with the task by
construction — directory membership is the declaration, so no separate
registration call is needed for trace-native docs.

`listDocsForTask` becomes the **union** of:
- files present under the task's trace doc directory (trace-native docs), and
- external paths recorded in `task_docs` via `add-doc` (a repo file the user
  explicitly pulled in).

A missing directory yields an empty doc list, never an error. The existing
`add-doc` verb and `task_docs` table survive unchanged, now scoped to the
"associate an external/repo doc" case.

### Re-entry payload

The `trace skill re-enter` verb is upgraded from a flat reference dump to an
ordered re-entry manifest. It returns:
- the task header (id, title, project root),
- the task's decision-docs (trace-native + external), and
- the task's session references with their transcript pointers, **newest-first**.

It returns **pointers, not inlined content** — the re-entering agent reads the
files itself. This keeps the sense-making (and its token cost) in the agent where
it belongs, and keeps the CLI deterministic and tool-agnostic. The most recent
session is identifiable so the agent knows which transcript to tail if it needs
the fallback.

### Transcript tail

A deep module behind `trace session tail <id>` that returns the last N
human/assistant message texts of a session's transcript as clean text,
abstracting over the per-tool transcript format (Claude JSONL vs Codex JSONL).
It encapsulates the same per-tool parsing seam the existing adapters already use.
This exists solely to make the fallback cheap — extracting the recent dialogue
of an in-flight chat without ingesting the whole transcript. Malformed or empty
transcripts return empty, never throw.

### Re-entry skill (cross-tool)

The thin client carrying the **consumption protocol**, present for both tools:
1. call `trace skill re-enter X`,
2. read the decision-docs first,
3. only if the docs don't cover the current state, read the transcript tail of
   the most recent session,
4. never paste raw transcripts; never re-explain.

The Claude `trace` skill's "Re-enter X" verb is updated to carry this protocol,
and a Codex-side entry point is added so the same verb works from Codex (the
Codex adapter already infers the thread from `CODEX_THREAD_ID`). The
`work-on-task` verb is also updated to tell the agent where the task's doc
directory is, so artifacts produced during work land in the captured location.

## Testing Decisions

The repo's pattern is vitest with on-disk fixtures (e.g.
`fixtures/claude-code-session.jsonl`); the three non-prose modules fit it well
and are where the tests should concentrate.

- **Task doc store** — directory-membership-is-association; `listDocsForTask`
  returns the union of trace-native and external (`add-doc`) docs without
  duplication; a missing directory yields an empty list (not an error).
- **Re-entry payload** — manifest includes both doc sources and all sessions;
  sessions are ordered newest-first; the most-recent session is identifiable;
  empty docs / empty sessions degrade to empty sections rather than failing.
- **Transcript tail** — last-N extraction against both a Claude and a Codex
  fixture; tool-agnostic output shape; malformed/empty/missing transcript returns
  empty without throwing.
- **Skill markdown** is prose and is not unit-tested; the existing `.mjs` helper
  forwarding can be smoke-tested as it is today.

## Out of Scope

- **Mid-session context-limit auto-trigger** ("you're at 100k, want a handoff?").
  Re-entry is pull, not push. Deferred fast-follow.
- **Session-end LLM summarisation.** Nothing summarises on session end; there is
  no LLM in the capture path.
- **Raw full-transcript ingestion.** Docs are primary; only the transcript tail
  is used, as a fallback.
- **Code-artifact tracking.** Code lives in git and the re-entering agent reads
  the repo anyway; trace carries decision-docs, not code pointers.
- **"Promote docs back into the repo" export.** A retention feature, not needed
  for the re-entry moment. Deferred fast-follow.
- **Rewiring the `scope`/`spec`/`slice`/`implement` skills** to write into the
  trace doc directory. v1 owns the doc-dir contract and its own skill writes
  there; migrating the workflow skills is a follow-up once the loop is proven.
- **Web view and token rollup.** Existing features, untouched by this work.

## Open Questions

- **Codex skill packaging.** How does the Codex-side re-entry entry point get
  discovered and invoked (AGENTS.md instruction, a `~/.codex` skill, or a
  documented command)? This is the one genuine unknown; the Claude side already
  has a skill home (`.claude/skills/trace`).
- **Transcript-tail default N** — how many recent messages constitute "the tail"
  by default (configurable, but needs a sensible default).
