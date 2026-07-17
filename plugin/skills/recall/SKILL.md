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

Do **not** use this skill when the user names an exact slug or title (that is
the `trace-reenter` skill), starts genuinely new work (the `trace` skill), or
asks to open the board (the `trace-board` skill).

## Flow

### 1. Fetch the candidate pool

Run, from the project the user is in:

```sh
node /Users/arielbk/Projects/side/trace-v2/apps/cli/dist/trace.js skill recall-candidates
```

It prints a JSON array of the project's unarchived tasks, each
`{ title, slug, description? }`. This is the entire pool — there is no search
index. Match against it yourself; never invent a task that is not in the array.
An empty array means there is nothing to recall (go straight to step 4).

By default the pool is scoped to the project root resolved from the CLI's
working directory. When the user is recalling work that clearly lives in a
**different** project than where the CLI is running — e.g. you are in a
multi-project sandbox or wrapper directory but the recalled work belongs to a
specific repo — pass `--project <dir>` pointing at that project so the candidate
pool is scoped to its git root instead of cwd's:

```sh
node /Users/arielbk/Projects/side/trace-v2/apps/cli/dist/trace.js skill recall-candidates --project /path/to/that/repo
```

Default to cwd (omit the flag) unless you have a concrete reason the recalled
work belongs to another project. A nonexistent `--project` path is a hard error.
`--project` scopes only this candidate-pool lookup; the re-entry in step 3
resolves the already-matched task by its slug and binds to it directly, so no
`--project` is needed there.

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

### 3. Confident match → announce, then delegate to `trace-reenter`

State the match. Announce in this shape (use the task's stored description
when present):

> Re-entering **{title}** — {description}

Recall's job ends at _resolving identity_. Once you have a confident match,
hand off to the **`trace-reenter` skill** — it owns the re-entry flow. Re-enter
the resolved task by its slug (the canonical ref):

```sh
node /Users/arielbk/Projects/side/trace-v2/apps/cli/dist/trace.js skill re-enter "{slug}"
```

This single command both fetches the re-entry manifest **and** binds the
current session to the task, atomically — there is no separate `work-on-task`
bind step. Then consume the manifest exactly as the `trace-reenter` skill
documents (read `state.md` first as authoritative, then `docs:` as linked, then
the `mostRecent: true` transcript tail only as a fallback; never paste raw
transcripts; never re-ask for context the manifest already covers). The
manifest-consumption protocol lives in one place — `trace-reenter` — so recall
does not restate it here.

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
