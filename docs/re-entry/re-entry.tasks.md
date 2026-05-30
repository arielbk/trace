# Handoff Re-entry

Make re-entry the moment trace earns its keep: from a fresh agent, "re-enter task X"
picks up the thread with zero re-explaining — fed by decision-docs (primary) and a
transcript tail (fallback). The first verified run is same-tool (Claude → `/clear` →
re-enter); cross-tool (Codex) re-entry is a deferred follow-up, and the architecture
stays tool-agnostic so it slots in later.

## Slices

### `doc-store` — Task docs live in the trace home

**Status:** done

**Outside-in:** Task docs resolve to `~/.trace/tasks/<taskId>/docs/` (derived from the same home/override as the DB path). Writing any file into that directory associates it with the task — no registration call. `trace task show X` / `re-enter X` list those files. `listDocsForTask` returns the union of trace-native docs (files in the dir) and external paths recorded via `add-doc`, de-duplicated.

**Feedback loop:** Vitest: a file written into the task doc dir appears in `listDocsForTask`; union with an `add-doc`'d external path contains both without duplicates; a task with no doc dir returns an empty list (no throw).

**Human checkpoint:** no

**Depends on:** none

### `transcript-tail` — Recent-dialogue extraction

**Status:** done

**Outside-in:** `trace session tail <id>` prints the last N human/assistant message texts of a session's transcript as clean text, abstracting over Claude JSONL vs Codex JSONL. N has a sensible default and is overridable via a flag.

**Feedback loop:** Vitest against both the Claude and Codex fixtures: returns the last N messages in order with tool-agnostic shape; a malformed/empty/missing transcript returns empty without throwing.

**Human checkpoint:** no

**Depends on:** none

### `re-entry-payload` — Ordered re-entry manifest

**Status:** done

**Outside-in:** `trace skill re-enter X` returns a manifest (not a flat dump): task header (id, title, project root), the task's decision-docs (trace-native + external), and the task's session references with transcript pointers ordered newest-first, with the most-recent session identifiable. Pointers only — not inlined content. Missing docs / missing sessions degrade to empty sections.

**Feedback loop:** Vitest: manifest includes both doc sources and all sessions; sessions ordered newest-first; most-recent session is flagged/identifiable; empty docs and empty sessions render as empty sections rather than errors.

**Human checkpoint:** no

**Depends on:** doc-store

### `re-entry-skill` — Re-entry consumption protocol (Claude)

**Status:** not-started

**Outside-in:** The `trace` skill's "Re-enter X" verb carries the consumption protocol an agent follows: (1) call `re-enter X`, (2) read the decision-docs first, (3) only if the docs don't cover current state, read the transcript tail of the most-recent session, (4) never paste raw transcripts, never re-explain. The `work-on-task` verb tells the agent where the task's doc directory is, so artifacts produced during work land in the captured location. Codex entry point is left as an explicit seam (deferred), not built.

**Feedback loop:** Smoke-test the `.mjs` helper forwarding (re-enter / work-on-task reach the CLI as today); human review of the skill prose for the protocol. Manual: in a session, `work-on-task` then write a doc into the reported dir and confirm `re-enter` surfaces it.

**Human checkpoint:** yes

**Depends on:** re-entry-payload, transcript-tail

### `setup-path` — One-command install (`trace init`)

**Status:** not-started

**Outside-in:** A single `trace init` wires up everything a fresh user needs: it registers the `SessionStart` hook into the appropriate `settings.json` (currently present in code but unwired), confirms the `trace` skill is discoverable, and reports what it did + anything still manual (e.g. the one-time `pnpm link --global` that must precede it, since the CLI must exist to be invoked). Idempotent — re-running it doesn't duplicate the hook. After running it, starting a Claude session registers in the store with no manual editing.

**Feedback loop:** Vitest: `trace init` against a temp home/settings writes the hook entry; a second run is a no-op (no duplicate). Manual on a clean checkout: link, run `trace init`, start a Claude session, confirm `trace session list --unassigned` shows it (proving the hook fired).

**Human checkpoint:** yes

**Depends on:** re-entry-skill

### `readme-walkthrough` — First-user README + verified hero loop

**Status:** not-started

**Outside-in:** Replace the Turborepo-starter README with a first-user guide: what trace is, the hero (re-enter a task with zero re-explaining), setup (link + `trace init`), and a walked same-tool hero loop — work on a task in Claude, `/clear`, re-enter it, and confirm the fresh agent picks up the thread. README states cross-tool (Codex) re-entry as the next increment.

**Feedback loop:** Human run: the first user (repo owner) follows the README on a clean setup end-to-end — installs, works a task, clears, re-enters — and confirms no re-explaining was needed. This is the acceptance gate for the feature.

**Human checkpoint:** yes

**Depends on:** setup-path
