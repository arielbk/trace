# Usable v1

Closes the last mile to a day-to-day usable Trace: capture the model per session,
make the `trace` CLI reachable without repo paths, ship an in-repo Claude Code
skill that drives it from natural language, and give the read-only web view enough
color to read a timeline at a glance.

## Slices

### `model-capture` — Model captured end-to-end

**Status:** done

**Outside-in:** `trace session register --model claude-opus-4-7 …` persists the model; `trace task timeline <id> --json` includes a `model` field on each session item (null/`"—"` when absent). Both adapters fill it in automatically from the transcript.

**Feedback loop:** vitest — extend the Claude Code and Codex fixtures with `model` fields and assert each adapter returns the expected model alongside unchanged token totals (and handles absent model as null); store test round-trips `model` (set + null) through `registerSession` and onto timeline session items, with re-register idempotency intact; migration leaves existing rows readable; CLI test asserts `register --model` + `timeline --json` carries it.

**Human checkpoint:** no

**Depends on:** none

### `cli-link` — `trace` reachable without a repo path

**Status:** done

**Outside-in:** `trace task list` (and any subcommand) runs from any directory after `pnpm link --global`, executing the existing `.ts` entry under Node 24. If linking the TS bin is unreliable, a thin root-level launcher/script forwards argv to the CLI entry instead.

**Feedback loop:** manual: from a directory outside the repo, `trace task list` returns the global-store tasks (exit 0); confirm the chosen mechanism (link or shim) is documented in one place the skill can reference. No npm publish, no tsup build.

**Human checkpoint:** no

**Depends on:** none

### `repo-skill` — In-repo Claude Code skill over the CLI

**Status:** not-started

**Outside-in:** A single skill checked into the repo (`SKILL.md` + any helper) dispatching two verbs: "we're working on X" resolves-or-creates task X and registers-and-binds the current Claude Code session (using the live session id + transcript path) via `trace`; "re-enter X" surfaces the task's docs + prior-session references as context via `trace skill re-enter`.

**Feedback loop:** vitest — a scripted round-trip with no live session drives work-on-task through the real `trace` CLI with a simulated session id and asserts the session is bound, then drives re-enter and asserts the expected docs + session refs appear (mirrors the existing skill-wrapper smoke test). Human checkpoint then exercises the natural-language path in a real Claude Code session.

**Human checkpoint:** yes

**Depends on:** cli-link

### `web-color` — Colored tool tag, model chip, baseline page styling

**Status:** not-started

**Outside-in:** The web timeline renders each session with a color-coded tool tag (claude / codex) and a muted model chip (`—` when null), on a page with baseline styling — readable type, spacing/padding, a header, subtle row separation. Read-only; data layer and core untouched beyond carrying `model`.

**Feedback loop:** vitest — extend the headless web data-layer test to seed a session with a model and assert it surfaces in the rendered timeline data, matching `trace task timeline --json`. Human checkpoint eyeballs the running app: tags are colored per tool, model chip shows, page reads as intentional (not raw HTML).

**Human checkpoint:** yes

**Depends on:** model-capture
