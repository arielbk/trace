---
name: trace
description: Use in Codex to bind the current Codex thread to a Trace task, re-enter an exact Trace task, or continue task work without re-explaining prior context.
---

# Trace for Codex

Use this skill in Codex when the user asks to work on, track, resume,
re-enter, or continue a Trace task.

## Resolve the Trace CLI

Use the pinned Trace CLI package:

```sh
npx @arielbk/trace@0.1.0 ...
```

The package version is intentionally exact; do not replace it with `@latest`.

## Backfill Codex sessions first

Before binding or re-entering, backfill Codex sessions so the current and recent
Codex threads exist in the Trace store:

```sh
npx @arielbk/trace@0.1.0 session scan --codex
```

This uses `CODEX_HOME` when set, otherwise `$HOME/.codex`.

## Work on a task

When the user starts or continues work on a task, resolve or create the task and
bind the current Codex thread:

```sh
npx @arielbk/trace@0.1.0 skill work-on-task "Task title" --description "One-line summary"
```

The CLI infers the current Codex thread from `CODEX_THREAD_ID` and the
transcript from `CODEX_TRANSCRIPT_PATH` when present. Use `--description` only
when creating a new task; omit it for an existing task. The command prints
`taskDocsDir: <path>`. Put task-specific plans, notes, and handoffs there.

## Re-enter a task

When the user names an exact task slug or title to resume, backfill first, then
run:

```sh
npx @arielbk/trace@0.1.0 skill re-enter "task-slug-or-title"
```

This command prints the re-entry manifest and binds the current Codex thread
when `CODEX_THREAD_ID` is available. Do not issue a separate `work-on-task`
after `re-enter`.

## Consume the manifest

Read context in this order:

1. Use `description:` to confirm the task identity.
2. If `state:` is present, read that file first. Treat it as the authoritative
   current snapshot.
3. Read docs listed under `docs:` only when `state:` points to them or the
   current work needs them.
4. If there is no `state:`, read decision docs first, then use the transcript
   tail for the `mostRecent: true` session only when docs do not cover current
   state.

Never paste raw transcripts into chat, and never ask the user to re-explain
context that the manifest, docs, or transcript tail already covers.
