---
name: trace
description: Bind the current session to a Trace task, and re-enter prior task context. Use when the user names a specific piece of work they are starting, resuming, or continuing — including "scope out X", "define a new X", "plan the work for X", "build X", "tackle X", "add X to Y", "work on X", or "get back to X". Covers features, bugs, and refactors. Trace fires first when the user names a feature, bug, or task to start; other skills then do the planning or execution. Does NOT apply when actively debugging or investigating a running system ("this endpoint is throwing errors", "help me debug X") — that is not starting a new piece of work. Also use when explicitly asked to bind a session to a task, or when session-start context reports no active task during real project work.
---

# Trace

Use this skill when the user names a specific feature, fix, or task they are
starting or about to do — even when phrased as "scope out X", "define a new X",
"plan the work for X", "build X from scratch", "tackle X", or "add X to Y".
Trace binds the session before any planning skill runs; other skills do the
subsequent planning or execution. Also use when the user asks to bind the
current session to a task, or when session-start context reports there is no
active task for this session.

## First, follow your host's binding flow

Trace runs in both Claude Code and Codex. They differ only in how a session is
identified and in how the "no active task" signal arrives — the verbs below are
the same in both. Before binding, read the file for your host and follow it:

- **Claude Code** — you run with `CLAUDE_CODE_SESSION_ID` in the environment and
  receive a SessionStart line about this session's task state. Read
  [resources/claude.md](resources/claude.md).
- **Codex** — you run with `CODEX_THREAD_ID` in the environment and have no
  session-start hook. Read [resources/codex.md](resources/codex.md).

## We're working on X

Resolve an existing task by slug or title `X`, or create one when absent, then
bind the current session to it. New task titles should be human-readable
sentence case ("Break stop and stale expiry"), not kebab-case — the slug is
derived automatically.

Starting to **scope or define** a piece of work counts as working on it: when
the user begins scoping, speccing, or defining a feature (e.g. "let's define
X", "let's scope X", or invoking a planning skill on X), run this same verb
with the feature as the title. The printed `taskDocsDir:` is then in
conversation for downstream skills that produce planning artifacts, so they
know where to write without any extra wiring.

When this **creates** a new task, write a one-line `--description` from the
conversation context — what the work actually is, in the user's terms — so the
task is recognisable later (this is the text the recall skill and the task page
surface). Draft it yourself from what you know; don't stop to interview the
user for it.

```sh
npx @arielbk/trace@0.1.0 skill work-on-task "X" --description "Rework the checkout into a multi-step wizard"
```

`--description` only seeds a freshly created task; when the task already
exists, drop the flag (tending an existing description on re-entry is handled by
the `trace-reenter` skill).

By default the task keys to the project root resolved from the CLI's working
directory. When the work clearly lives in a **different** project than where the
CLI is running — e.g. you are in a multi-project sandbox or wrapper directory but
the task belongs to a specific repo — pass `--project <dir>` pointing at that
project so the task keys to its git root instead of cwd's:

```sh
npx @arielbk/trace@0.1.0 skill work-on-task "X" --project /path/to/that/repo
```

Default to cwd (omit the flag) unless you have a concrete reason the work belongs
to another project. A nonexistent `--project` path is a hard error. The same
`--project <dir>` flag is accepted by `trace task create` and `trace task
capture` for the same reason.

The command prints `taskDocsDir: <path>`. Put task-specific decision docs,
plans, handoffs, and notes in that directory so future re-entry sees them
without a separate registration step.

## Re-enter a task

When the user names an exact task slug or title to resume, hand off to the
`trace-reenter` skill, which owns the re-entry flow — it fetches the manifest
and binds the current session atomically. Don't issue a separate `work-on-task`
bind after re-entry.
