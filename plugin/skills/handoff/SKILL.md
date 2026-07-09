---
name: trace-handoff
description: Distill the current session into the bound task's living state file (`state.md`). Use when the user signals they are wrapping up, moving to a new chat, handing off, or says phrases like "let's hand this off", "wrap this up", "new chat", "end of session", or "save state".
---

# Trace handoff

Use this skill when the user signals they are wrapping up a session —
"let's hand this off", "new chat", "wrap this up", "save state", or any
equivalent. The skill captures where things stand into a single living
`state.md` in the bound task's docs dir. Running it a second time updates
the same file in place; there is never a second file.

Do **not** use this skill mid-session to checkpoint arbitrary progress. It is
a wrap-up verb, not a general note-taking verb.

## Flow

### 1. Resolve the docs directory

Follow the `trace-doc-placement` skill's resolution flow verbatim:

```sh
npx @arielbk/trace@0.10.0 skill docs-dir
```

**Exit 0 — session is bound.** stdout contains `taskDocsDir: <path>`. Extract
`<path>`. Continue to step 2.

**Non-zero exit — session is unbound.** stderr carries an actionable message:
either `re-enter <slug>` (a recent candidate exists) or `work-on-task <title>`
(no candidate). Surface the message to the user and offer the matching bind
verb:

- When stderr names a `re-enter` command: offer to **Re-enter X** (the `trace`
  skill's re-enter verb) to pick up from the prior context.
- When stderr names a `work-on-task` command: offer to **Start tracking X**
  to create and bind a new task.

If the user agrees and the bind completes, capture the emitted
`taskDocsDir: <path>` and continue to step 2. If the user declines, explain
that handoff requires a bound task, write nothing, and stop.

### 2. Read any existing `state.md`

```
<taskDocsDir>/state.md
```

If the file exists, read it fully — this is the accumulated state from prior
sessions. You will merge this session's developments into it. If it does not
exist, you are writing it fresh.

### 3. Identify this session's developments

From the current conversation context, identify what changed in this session:

- Decisions that were made (architectural choices, approaches agreed on,
  approaches ruled out)
- What was implemented, fixed, or changed
- Where things stand right now (what's working, what isn't, current state of
  the code or plan)
- The concrete next step a fresh agent should take to continue
- Open questions that remain unresolved

When a prior `state.md` exists, fold the new developments in: update each
section to reflect the current state rather than appending per-session notes.
The file accumulates state across sessions — it is a snapshot of *now*, not a
log. Old decisions that are still load-bearing stay; superseded decisions get
replaced or struck.

### 4. Write `state.md`

Write the file to `<taskDocsDir>/state.md` using this structure:

```markdown
# <one-line summary of where things stand now>

## Decisions made

<Bullet list of key decisions. Include the reasoning briefly when it affects
future choices. Omit decisions that are obvious from the code.>

## Current state

<1–3 paragraphs: what's working, what's in place, what's broken or incomplete.
Concrete and specific — a fresh agent reading this should know exactly what
the codebase looks like right now.>

## Next step

<The single most important thing a fresh agent should do to continue this work.
One clear, actionable task, not a list.>

## Open questions

<Bullet list of unresolved questions or decisions. Mark "unblocking" if one
needs to be resolved before the next step can proceed. Write "none" only if
there genuinely are none.>
```

**Do not write a docs footer.** The list of other docs in this task is a
machine-owned region rendered automatically by `trace task add-doc` (and
`update-doc`). It is delimited by HTML-comment fence markers:

```
<!-- trace:docs-manifest:start -->
...
<!-- trace:docs-manifest:end -->
```

If the existing `state.md` you read in step 2 already contains this fenced
region (along with the `---` divider immediately above it), **preserve it
verbatim** — write your prose sections above it and leave everything from the
`---` divider through the closing fence marker exactly as you found it. Never
hand-write an "Other docs in this task" footer; doing so would duplicate the
rendered manifest.

### 5. Confirm

After writing, report the full path of the file written and the one-line
summary you used, so the user can confirm the handoff captured what they
intended.

## Notes

- The file is always `state.md` — never `state-2026-05-17.md` or a second
  state file. The living state is in one place; per-session history lives in
  the transcripts.
- Write plain prose and bullets. No code blocks, no diffs. Code lives in git.
- When merging, prefer accuracy over length. A shorter, accurate state file
  is better than a long one that mixes stale and current state.
- If the task has a `re-enter` manifest line `state: / path: <path>`, that
  path IS `<taskDocsDir>/state.md` — they are the same file.
