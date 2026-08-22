---
name: trace-state
description: Distill the current session into the bound task's living state file (`state.md`) — its prose sections, in the structure the board and re-entry read. Use when the user signals they are wrapping up, moving to a new chat, handing off, or says phrases like "let's hand this off", "hand off", "wrap this up", "new chat", "end of session", or "save state"; and whenever a Trace trigger (the `Stop` hook or `trace state check`) reports that `state.md`'s prose has drifted from — or is missing for — the task's current docs.
---

# Trace state

Use this skill to bring the bound task's living `state.md` up to date. It has
two triggers, the same operation either way:

- **The user is wrapping up** — "let's hand this off", "hand off", "new chat",
  "wrap this up", "save state", or any equivalent. The classic handoff.
- **The prose has drifted** — a Trace trigger (the main-agent `Stop` hook,
  `trace state check`, or a `stateFreshness:` block in a re-entry manifest)
  reports the task's docs have moved ahead of `state.md`'s prose, or that
  `state.md` has no prose yet. When the trigger is the `Stop` hook, the agent
  is still warm from the doc work and writes the prose from this session's
  context. When it is a re-entry manifest — drift that survived a session
  boundary, typically from a platform with no live hook — derive the prose
  from the docs and the prior session's trail instead: you have just read
  them to orient, so fold what they establish into the sections below.

The skill captures where things stand into a single living `state.md` in the
bound task's docs dir. Running it a second time updates the same file in
place; there is never a second file.

You do not need to debounce this yourself — the drift trigger only fires on a
real docs change (a fingerprint gate), so this is not a per-turn note-taking
verb. Write `state.md` whenever a trigger above asks for it.

## Flow

### 1. Resolve the docs directory

Follow the `trace-doc-placement` skill's resolution flow verbatim:

```sh
trace skill docs-dir
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
that this skill requires a bound task, write nothing, and stop.

### 2. Read any existing `state.md`

```
<taskDocsDir>/state.md
```

If the file exists, read it fully — this is the accumulated state from prior
sessions. You will merge this session's developments into it. If it does not
exist, you are writing it fresh. Legacy files may still contain Decisions made
or Open questions sections; do not copy those sections into the rewrite.
Decisions belong in durable task documents.

### 3. Identify this session's developments

From the current conversation context, identify:

- A one-sentence summary of where the work stands now
- The current position — **one paragraph**, plainly written, of what's in
  place, working, or incomplete
- The single next action, or the unresolved question that *is* the next step

When a prior `state.md` exists, fold the new developments in: rewrite the
snapshot of *now* rather than appending per-session notes.

**This file is an orientation note, not a report.** A fresh agent reads it to
learn where to look — the task's docs hold the detail, and the manifest footer
below your prose already points at every one of them. So:

- **`## Current state` is one paragraph.** Not two, not three. If it will not
  fit, that is the signal that something in it belongs in a doc.
- **Point, don't restate.** When a defect, decision, or plan is already written
  up in a task doc, name it in a clause and link the doc — never re-narrate its
  reasoning, file paths, or line numbers here.
- **Drop what stopped mattering.** Superseded detail, resolved questions, and
  the play-by-play of how the work got here belong in the transcripts. Prune on
  every rewrite; a state file that only ever grows has stopped being a snapshot.
- **Write plainly.** Short sentences, ordinary words, no piled-up subclauses.

### 4. Write `state.md`

Write the file to `<taskDocsDir>/state.md` using this structure. Omit any
section that has nothing to say — do not stub it with a placeholder.

```markdown
# <one-sentence summary of where things stand now>

## Current state

<One paragraph: what's working, what's in place, what's broken or incomplete.
Enough that a fresh agent knows the current position and which doc to open
next — not enough to replace those docs.>

## Next step

<The single most important next action — or the unresolved question that
must be answered before work can continue. Not a list.>
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

### 5. Stamp the fingerprint

After writing the prose, stamp `state.md` so Trace records that the prose now
reflects the current docs:

```sh
trace state reflect <slug>
```

This advances the prose-fingerprint marker. Skipping it leaves the marker stale,
so the next session's `Stop` hook (or `trace state check`) would block again for
drift even though the prose is fresh. Always run it after a prose write —
whether you got here from a wrap-up or from a drift trigger.

### 6. Confirm

After writing, report the full path of the file written and the one-line
summary you used, so the user can confirm the state file captured what they
intended.

## Notes

- The file is always `state.md` — never `state-2026-05-17.md` or a second
  state file. The living state is in one place; per-session history lives in
  the transcripts.
- Write plain prose. No code blocks, no diffs. Code lives in git.
- Length is the failure mode this file actually suffers from. A short snapshot
  that points at the right doc beats a long one that inlines it — and beats a
  complete one that mixes stale detail with current state. When accuracy seems
  to demand more words, put those words in a task doc and link it.
- If the task has a `re-enter` manifest line `state: / path: <path>`, that
  path IS `<taskDocsDir>/state.md` — they are the same file.
