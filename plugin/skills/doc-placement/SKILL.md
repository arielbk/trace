---
name: trace-doc-placement
description: Place a document (spec, PRD, plan, handoff, note) in the correct docs directory for the current Trace task. Use when the user is creating any task-level document and wants it saved in the right place, or when another planning or spec-driven workflow (writing a spec, PRD, brainstorm, design doc, or task breakdown) is about to write a planning artifact and needs to know where to put it.
---

# Trace doc placement

Use this skill when the user is creating a task document — a spec, PRD, plan,
handoff, decision note, or any other artifact that belongs in the current
Trace task's docs directory — and you need to know where to put it, or when
you are about to write such a file and want to land it in the right place
without guessing from conversation scrollback.

## Flow

### 1. Resolve the docs directory

```sh
npx @arielbk/trace@0.6.0 skill docs-dir
```

Two outcomes:

**Exit 0 — session is bound.** stdout contains `taskDocsDir: <path>`. Extract
`<path>` and use it as the target directory for the document. Jump to step 2.

**Non-zero exit — session is unbound.** stderr contains an actionable message:
either `re-enter <slug>` (a recent candidate exists) or `work-on-task <title>`
(no candidate). Surface the message to the user and offer the matching bind
verb before placing the document:

- When stderr names a `re-enter` command: offer to **Re-enter X** (the
  `trace` skill's re-enter verb) so the session picks up from where it left off.
- When stderr names a `work-on-task` command: offer to **Start tracking X**
  (the `trace` skill's work-on-task verb) so a new or existing task is created
  and bound.

Once the user agrees and the bind completes (the `trace` skill emits
`taskDocsDir: <path>`), capture that path and continue to step 2.

Do not guess a directory, create one ad-hoc, or fall back to the repo root.
If the user declines to bind, explain that placement requires a bound task
and stop.

### 2. Write the document

Place the file in the resolved `<path>`. Use a slug-style filename that
reflects the document's content (e.g. `checkout-flow.prd.md`,
`auth-rewrite.decisions.md`). Do not nest subdirectories unless the user
asks for them — flat is easier to scan during re-entry.

### 3. Register the document

Register the file with the task so it appears in the task's docs manifest. The
resolved `taskDocsDir` is `~/.trace/tasks/<slug>/docs/`, so the task `<slug>` is
the directory name two levels above `docs/` — use it as the `add-doc` ref:

```sh
npx @arielbk/trace@0.6.0 task add-doc <slug> <path> --description "<one-line description>"
```

- `<slug>` — the task slug extracted from `taskDocsDir` (the segment before
  `/docs/`).
- `<path>` — the full path to the file you just wrote.
- `--description` — a one-line summary of what the doc is (strongly
  recommended; it is rendered next to the link in state.md's manifest footer so
  a re-entering agent can scan the index without opening each doc). Omit the
  flag only when no meaningful one-liner exists.
- `--title` — an explicit display title; defaults to the doc's H1 or filename.

This re-renders the machine-owned docs-manifest footer in the task's state.md,
so the manifest stays current without a manual handoff. After registering,
report the full path so the user sees where it landed.

`add-doc` registers a doc once; on an already-registered `(slug, path)` it
no-ops. To set or change a title/description **after** registration — including
on filesystem-discovered native docs like state.md, tasks.md, and log.md that
were never explicitly registered — use `update-doc`, which upserts the row:

```sh
npx @arielbk/trace@0.6.0 task update-doc <slug> <path> --description "<one-line description>"
```

Pass `--title`/`--description` to set a field, `--title ""`/`--description ""`
to clear it; omitted flags are left untouched.

## Notes

- `docs-dir` resolves the directory from the live session→task binding, not
  from conversation scrollback. It is always authoritative; never derive the
  path yourself from prior messages.
- `taskDocsDir` is slug-keyed: `~/.trace/tasks/<slug>/docs/`. UUID-based
  paths do not exist in this system.
- When called from another planning skill (a spec, PRD, brainstorm, design, or
  task-breakdown workflow), simply return the resolved path for the caller to
  use — no need to re-confirm with the user if the session is already bound.
