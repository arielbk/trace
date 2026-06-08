---
name: trace-doc-placement
description: Place a document (spec, PRD, plan, handoff, note) in the correct docs directory for the current Trace task. Use when the user is creating any task-level document and wants it saved in the right place, or when another skill (scope, spec, slice, implement) is about to write a planning artifact and needs to know where to put it.
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
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill docs-dir
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

After writing, report the full path so the user sees where it landed.

## Notes

- `docs-dir` resolves the directory from the live session→task binding, not
  from conversation scrollback. It is always authoritative; never derive the
  path yourself from prior messages.
- `taskDocsDir` is slug-keyed: `~/.trace/tasks/<slug>/docs/`. UUID-based
  paths do not exist in this system.
- When called from another skill (scope, spec, slice, implement), simply
  return the resolved path for the caller to use — no need to re-confirm
  with the user if the session is already bound.
