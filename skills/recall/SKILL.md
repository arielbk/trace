---
name: trace-recall
description: Resolve a vague reference to prior work ("let's get back to that archiving thing", "what was that task about checkout", "pick up where we left off on the wizard") against the current project's tasks, then re-enter and bind the right one. Use when the user gestures at earlier work without naming an exact task title.
---

# Trace recall

Use this skill when the user references prior work **without** giving an exact
task title — e.g. "let's get back to that archiving thing", "where were we on
the checkout work", "pick up that wizard task again". The job is to turn the
vague reference into the right existing task and re-enter it, or — when nothing
matches confidently — to ask rather than guess.

Do **not** use this skill when the user names an exact title, starts genuinely
new work, or asks to open the board — those are the `trace` skill's verbs.

## Flow

### 1. Fetch the candidate pool

Run, from the project the user is in:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill recall-candidates
```

It prints a JSON array of the project's unarchived tasks, each
`{ title, slug, description? }`. This is the entire pool — there is no search
index. Match against it yourself; never invent a task that is not in the array.
An empty array means there is nothing to recall (go straight to step 4).

### 2. Match the reference against the pool

Read the user's reference and compare it against each candidate's `title` and
`description`. Decide between three outcomes:

- **One confident match** — the reference clearly points at exactly one task
  (its description or title plainly covers what the user gestured at, and no
  other candidate is a plausible read). → step 3.
- **Ambiguous** — two or more candidates are plausible, or one is only a loose
  fit. → step 4.
- **No match** — nothing in the pool fits. → step 4.

When unsure between confident and ambiguous, treat it as ambiguous and ask. A
wrong silent bind is worse than one clarifying question.

### 3. Confident match → announce, re-enter, bind

State the match. Announce in this shape (use the task's stored description
when present):

> Re-entering **{title}** — {description}

Fetch the task's re-entry manifest — its decision docs and prior session
references — **before** binding, so the manifest's `mostRecent: true` session
is the prior session, not this one:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill re-enter "{title}"
```

Then bind the current session by exact title:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill work-on-task "{title}"
```

Consume the manifest: read the decision docs first, in the listed order; only
fall back to the transcript tail of the `mostRecent: true` session (via
`trace session tail <session-id>`) when the docs do not cover current state.
Never paste raw transcripts into the chat, and never re-ask the user for
context the manifest or docs already hold.

### 4. Ambiguous or no match → ask, never auto-create

Present the 2–3 nearest candidates (title + a few words of description) and ask
the user which they mean. Always include an explicit escape hatch:

> None of these → start a new task with a description.

Only create a new task when the user explicitly chooses to. A failed recall
**must never auto-create** and **must never auto-bind** a task — silent creation
on a missed reference is exactly the friction this skill exists to avoid. When
the user does choose to create, hand off to the `trace` skill's work-on-task
flow with a description drawn from the conversation.

## Notes

- The candidate pool is scoped to the current project root (where the user is
  working) and excludes archived tasks — so recall never surfaces finished or
  unrelated work.
