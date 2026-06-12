# PRD: Codex-side re-entry (Claude → Codex)

## Problem Statement

trace's hero loop is proven same-tool: work a task in Claude Code, `/clear`, re-enter,
keep going. But the store, transcript adapters, and re-entry manifest are already
tool-agnostic — the only thing stopping a task worked in Claude from being picked up in
Codex is that Codex has no entry point. A user who switches to Codex mid-task has to
reconstruct the thread by hand, which is exactly the problem trace exists to remove. The
README calls this the "deferred Codex path" and hand-waves it as "a session hook + skill
wrapper"; in practice the consume side is already built and only Codex-side ergonomics are
missing.

## Solution

Give Codex the same two affordances Claude already has, reusing the existing tool-agnostic
CLI underneath:

1. A **Codex-side `trace` skill** that teaches a Codex agent the re-entry protocol — call
   `re-enter X`, read decision docs first, fall back to the most-recent session transcript
   tail only when docs are insufficient, never paste raw transcripts.
2. **Capture of the current Codex session** so a task started or continued in Codex lands
   in the store — done by backfill (`session scan --codex`) triggered from the skill, not a
   live hook.
3. **`trace init` wiring** to install the Codex skill idempotently while keeping the
   Claude setup path plugin-owned.

The primary direction is **Claude → Codex**. The reverse path is smoke-tested because the
existing manifest and binding code already support it.

## User Stories

1. As someone who worked a task in Claude and switched to Codex, I want to re-enter the
   task in Codex and get its decision docs plus newest-first pointers to my prior Claude
   sessions, so that I keep going without re-explaining.
2. As a Codex agent, I want a discoverable `trace` skill that tells me the re-entry
   consumption protocol, so that I read docs first and only tail a transcript when docs
   don't cover current state.
3. As a user starting fresh in Codex, I want my Codex session captured against the task,
   so that the store reflects all work on the task regardless of which tool produced it.
4. As a user, I want `trace init` to install the Codex skill in one idempotent step, so
   that wiring Codex is as low-friction as wiring Claude.
5. As a Codex agent binding to a task, I want `work-on-task` to report the task docs
   directory, so that artifacts I produce land where future re-entry will find them.

## Implementation Decisions

**Reuse, don't rebuild.** The store, `codex-adapter`, `transcript-tail`, re-entry manifest,
`re-enter`, `work-on-task`, `session scan --codex`, and `CODEX_THREAD_ID` tool inference all
already exist and are tool-agnostic. No new store/adapter/manifest/CLI-verb code.

**Codex `trace` skill (new artifact).** A `SKILL.md` in the Codex skills format, bundled
under `codex/skills/trace/` for the Codex plugin and installed locally to
`~/.agents/skills/trace/` by `trace init`. It is _not_ a verbatim copy of the Claude skill —
that one is Claude-specific in prose and references `CLAUDE_*` env vars. The Codex skill
instead:

- carries the same consumption protocol (re-enter → docs first → transcript tail fallback →
  never paste raw transcripts);
- invokes the bundled Trace CLI's `skill work-on-task` / `skill re-enter` verbs (the same
  title-based commands the Claude skill calls), which already infer the Codex session from
  `CODEX_THREAD_ID` and the transcript from `CODEX_TRANSCRIPT_PATH` when present;
- runs `trace session scan --codex` on invocation so the current Codex-started session is
  backfilled into the store before binding.

**Capture by backfill, not a live hook.** Codex exposes no clean session-start hook to
mirror Claude's `SessionStart`: the documented real-time slot is `notify` (fires only on
`turn-ended`) and it is a single global slot already occupied by other tooling. Codex does
write `session_index.jsonl` + `sessions/` itself, which `scan --codex` already reads, so
backfill reliably captures every Codex session including fresh ones. The architecture is
deliberately asymmetric: **Claude captures live via a hook; Codex captures by backfill.**
The store is identical either way.

**`trace init` extension.** `runInit` stays a Claude plugin diagnostic and does not write
Claude settings. It also installs or refreshes the Codex skill into the user skill
directory (`$HOME/.agents/skills/trace/SKILL.md`) with an absolute path to this checkout's
bundled `bin/trace.js`, and reports whether it installed or found an already-current copy.

## Testing Decisions

Prior art: `repo-skill.test.ts` drives the Claude skill helper end-to-end against a temp
`TRACE_DB`, and `codex-scan.test.ts` drives `session scan --codex` against a synthetic Codex
sessions directory + `session_index.jsonl`. Mirror both.

- **Codex skill end-to-end:** with `CODEX_THREAD_ID` set and a synthetic Codex sessions
  dir, invoking the Codex skill's `work-on-task` resolves/creates the task, backfills the
  current Codex session via `scan --codex`, binds it, and reports `taskDocsDir`; `re-enter`
  then prints the task docs and newest-first session references. Assert the Codex session is
  present and bound in the store.
- **Cross-tool re-entry:** seed a task with a Claude session + docs, then re-enter as Codex
  (`CODEX_THREAD_ID` set) and assert the manifest surfaces the Claude docs and Claude
  session pointers — proving the consume path is genuinely tool-agnostic. Also smoke-test
  Codex-created work re-entered from Claude, because that path requires no extra core code.
- **`trace init` idempotency for Codex:** running init installs the Codex skill into a temp
  Codex home; running it a second time reports "already present" and does not duplicate.

The Codex skill `SKILL.md` should be asserted to exist (as `repo-skill.test.ts` does for the
Claude `SKILL.md`).

## Out of Scope

- **A separate Codex → Claude implementation** — not needed for this increment; the existing
  manifest path is smoke-tested instead.
- **A live Codex session-start hook or `notify` shim** — explicitly rejected in favor of
  backfill; not built.
- **New store, adapter, transcript-tail, manifest, or CLI verb code** — all already exists
  and is tool-agnostic.
- **AI summarization of the re-entry payload** — still structured-raw, per the trace PRD.
