---
name: trace-reenter
description: Re-enter a Trace task the user names by its exact slug or title — bind the current session to it and load its context back from the re-entry manifest (state file, docs, prior session tail). Use when the user asks to re-enter, resume, reopen, or get back into a task and gives an exact slug or exact title; not for vague references (that is trace-recall) and not for starting or binding new work (that is trace).
---

# Trace re-enter

Use this skill when the user names an **exact** task slug or title to go back
into — "re-enter `break-stop-and-stale-expiry`", "reopen the Archive tasks
task", "resume break-stop-and-stale-expiry". It binds the current session to
that task and loads you back into its context from the re-entry manifest.

Do **not** use this skill when the user only gestures vaguely at prior work
("that archiving thing", "where were we on checkout") — that is `trace-recall`,
which resolves identity first and then delegates here. Do not use it to start or
bind genuinely new work — that is the `trace` skill's **We're working on X**
verb.

This skill is the single owner of the **manifest-consumption protocol**. Other
skills that need to re-enter a resolved task (e.g. `trace-recall` after a
confident match) delegate here rather than restating these rules.

## Re-enter the task

Resolve the task — the slug is the canonical ref; an exact title (trimmed,
case-insensitive) also resolves — then bind the current session and print the
manifest:

```sh
node /Users/arielbk/Projects/side/trace-v2/apps/cli/dist/trace.js skill re-enter "break-stop-and-stale-expiry"
```

This **one command both fetches the re-entry manifest and binds the current
session** to the resolved task. The CLI builds the manifest first — so the
manifest's `mostRecent: true` session is the _prior_ session, not this one —
then binds the current session, atomically. Binding is inferred from the live
session in the environment; run outside a session (a human at a bare terminal
reading the docs) there is nothing to bind, so it just prints the manifest.

Because `re-enter` already binds, **do not issue a separate `work-on-task`
bind** after it — that would be a redundant double-bind. Going back to a task is
itself working on it; the re-entered session no longer stays silently unbound.

A miss exits non-zero and lists near candidates (slug — title) on stderr; pick
the right slug from that list rather than guessing variants.

## Consume the manifest

Treat the command's output as a manifest and consume it in this order:

1. When the manifest carries a `description:` line, that is the task's stored
   summary — use it to orient and to confirm you have the right task; don't
   re-derive it.
2. If the manifest carries a `state:` field, **read that file first** and treat
   it as the authoritative snapshot of where the task stands. It is the living
   state file written by the `trace-state` skill — one summary line, decisions
   made, current state, next step, and open questions. Open with a recap drawn
   from it.
3. After reading `state.md`, pull other docs from `docs:` **only when**
   `state.md` links to them or the current work explicitly needs them. Do not
   read every sibling doc by default.
4. When **no** `state:` field is present, read the decision docs first, in the
   listed order, then fall back to the transcript tail for the `mostRecent: true`
   session with `trace session tail <session-id>` **only if** those docs do not
   cover the current state.
5. **Never paste raw transcripts** into the chat, and **never re-ask** the user
   to re-explain context that the manifest, docs, or transcript tail already
   cover.

## State freshness

The manifest may end with a `stateFreshness:` block — Trace's signal that
`state.md`'s prose no longer reflects the task's docs (`mode: refresh`) or was
never written (`mode: seed`). It appears only when there is real drift; most
re-entries won't carry it.

When it is present: **orient first, then repair.** Finish consuming the
manifest as above — re-entry stays a read — and open with your recap. Then, in
the same turn, invoke the `trace-state` skill to write or refresh the prose
(it stamps the pass via `trace state reflect <slug>` when done). Do not ask
the user for permission to do this; the block is the instruction.

This is the portable fallback for drift that survived a session boundary —
on platforms with a live `Stop` hook the prose is normally refreshed by the
still-warm agent, so this block mostly appears when the prior session ran
somewhere without one (Codex, Cursor) or docs changed out-of-band.

## Drift detection

If, once you are oriented, the work has visibly drifted from the stored
description — the task is now plainly about something the description no longer
captures — **offer** to update it, with the new text you'd write, and apply it
only if the user agrees. Never silently rewrite it.

```sh
node /Users/arielbk/Projects/side/trace-v2/apps/cli/dist/trace.js task update "X" --description "new one-line summary"
```

Most re-entries need no such update — only offer when the drift is obvious, not
on every re-entry.

The protocol is tool-agnostic: the same command and manifest-consumption rules
apply whether the session runs in Claude Code, Codex, or Cursor, and the
re-entered session is bound in all three.
