# PRD: Usable v1

The core of Trace is built and QA-passing — task CRUD, session register/assign,
the Claude Code + Codex adapters, the timeline rollup, a global SQLite store at
`~/.trace/trace.sqlite`, and a read-only Vite + React web view. What it lacks is
the last mile that makes it usable day-to-day: a low-friction way to drive the
CLI from inside an agent session, a CLI reachable without typing repo paths, the
model captured alongside each session, and enough color in the web view to read
a timeline at a glance. This PRD covers that last mile.

## Resources

- **Trace PRD** — `docs/trace/trace.prd.md` (the product this builds on; defines
  tasks, sessions, adapters, the one-session-one-task invariant).
- **Global store PRD / handoff** — `docs/global-store/global-store.prd.md`,
  `docs/global-store/global-store.handoff.md` (global `~/.trace/trace.sqlite`,
  ready-to-run CLI examples, current store state).
- **Confirmed model-field locations** (verified against real transcripts):
  - Claude Code JSONL — assistant messages carry `"model":"claude-opus-4-7"`.
  - Codex rollout JSONL — turn events carry `"model":"gpt-5.1-codex-max"`.

## Problem Statement

The tool works but isn't pleasant to use. To bind a session to a task you type a
long `node apps/cli/src/trace.ts …` invocation by hand; there's no skill so the
human can't just say "we're working on X" and have the agent do it. The CLI only
runs from the repo with an absolute path. The web view shows sessions as raw,
uncolored text, so you can't tell Codex from Claude at a glance — and the model,
which is a foundational fact about each session, isn't captured at all.

## Solution

Four changes, no new core concepts:

1. **A repo skill over the CLI.** A single Claude Code skill checked into the
   repo that handles both verbs — "we're working on X" (create-or-bind the
   current session to a task) and "re-enter X / what's the history of X" (print
   the task's docs + prior-session references as resumption context). It shells
   out to the `trace` CLI; it does not reach into the store directly.

2. **A frictionless CLI.** `trace` is reachable as a global command (via
   `pnpm link --global`) or, failing that, a thin root-level script that
   forwards to the CLI. No npm registry publish, no build pipeline. The skill
   calls a stable `trace` command rather than a repo path.

3. **Model captured end-to-end.** A nullable `model` field on sessions, set by
   both adapters from the confirmed transcript fields, accepted via a `--model`
   CLI flag, and carried through `registerSession` and the timeline rollup.

4. **Minimal web color.** Each session in the web view renders a color-coded
   tool tag (claude / codex) plus a muted model chip, on a page with baseline
   styling (readable type, spacing, a header, subtle row separation) so it reads
   as intentional. No theming, dark mode, component library, responsive work, or
   layout framework.

## User Stories

1. As a developer, I want to tell my Claude Code agent "we're working on the
   checkout task" and have it bind the current session to that task, so I never
   type a CLI invocation by hand.
2. As a developer, I want to say "re-enter the checkout task" and get back its
   associated docs and prior-session references, so I can resume with context.
3. As a developer, I want the skill to create the task if it doesn't exist yet,
   so the first mention of a task just works.
4. As a developer, I want to run `trace …` from anywhere without typing a repo
   path, so the CLI feels like a real installed tool.
5. As a developer, I want each session to record which model produced it, so the
   model is a first-class fact I can see and (later) aggregate on.
6. As a developer, I want the Claude Code and Codex adapters to fill in the model
   automatically from the transcript, so I don't supply it by hand.
7. As a developer, I want the web timeline to show a colored tag per tool, so I
   can tell Codex work from Claude work at a glance.
8. As a developer, I want each session to show its model next to the tool tag, so
   I can see what produced it without opening the transcript.
9. As a developer, I want the web view to look intentional (type, spacing,
   header) rather than raw HTML, so it's pleasant to skim.

## Implementation Decisions

**Skill (new, in-repo).** A single Claude Code skill checked into the repo
(`SKILL.md` + any helper), dispatching two verbs:
- *work-on-task* — resolve-or-create the task by title, then register-and-bind
  the current session using the live Claude Code session id (and transcript
  path) the skill has access to. Wraps the existing `trace skill work-on-task`
  path; if a token-rich register is wanted it can call `session register` +
  `session assign`. The skill must locate the session's own id/transcript and
  pass them through.
- *re-enter* — call the existing `trace skill re-enter <taskId>` and surface its
  docs + session-reference output as context.

The skill is the human-facing seam; it owns natural-language phrasing → CLI
commands. Codex-side skill is explicitly deferred (the CLI already works from
Codex; drive it manually there for now).

**CLI reachability.** Make `@trace/cli` linkable so `pnpm link --global` exposes
a `trace` binary that runs the existing `.ts` entry under Node 24's native TS
support. If linking the `.ts` bin proves unreliable, fall back to a thin
executable shim (a root-level script or a tiny JS launcher) that forwards argv to
the CLI entry. No tsup build, no registry publish, no version bump. The skill and
docs reference the resulting `trace` command.

**Model field (schema + store + adapters + rollup).**
- *Schema*: add a nullable `model` text column to the `sessions` table with a
  Drizzle migration; existing rows default to null/empty (rendered as "—").
- *Store*: `RegisterSessionInput` gains an optional `model`; `registerSession`
  persists it; the session type and timeline session items expose it. Re-register
  idempotency is preserved.
- *CLI*: `session register` and `skill work-on-task` accept an optional
  `--model` flag, threaded into the register input.
- *Adapters*: both adapters extract the model during the existing usage-accumulation
  pass — Claude from assistant-message `model`, Codex from the turn event `model` —
  last-seen-wins, returned alongside token totals. Where the adapter result feeds
  a register call, the model flows through.

**Web view.** The detail page (and task list where a tool/model is shown) renders
a tool tag with a per-tool color and a secondary model chip (plain text "—" when
model is null). Add a small amount of baseline page CSS — readable font stack,
spacing/padding, a header, subtle row separation. Styling lives in the web app
only; the data layer and core are untouched beyond carrying `model`.

## Testing Decisions

Follow the existing fixture-driven approach (vitest, real-shaped fixtures).

- **Adapters** — extend the Claude Code and Codex fixtures to include `model`
  fields and assert each adapter returns the expected model string alongside
  unchanged token totals. Assert null/absent model is handled (older transcripts).
- **Store** — assert `registerSession` round-trips `model` (set and null), that
  re-register idempotency still holds, and that the timeline rollup carries the
  model onto session items. The migration must leave existing rows readable.
- **Web data layer** — extend the existing headless web data-adapter test to seed
  a session with a model and assert it surfaces in the rendered timeline data,
  matching `trace task timeline --json`.
- **Skill** — a scripted round-trip (no live session) that drives work-on-task
  through the real CLI with a simulated session id and asserts the session is
  bound, then drives re-enter and asserts the docs + session refs appear. Mirrors
  the existing skill-wrapper smoke test.
- **CLI** — `session register --model …` and `skill work-on-task --model …`
  persist the model; `task timeline --json` includes it.

## Out of Scope

- **npm registry publish** — replaced by `pnpm link` / a root script. No build
  pipeline, no `@trace/core` bundling, no native-module prebuild work.
- **Codex-side skill** — deferred; the CLI works from Codex manually.
- **Dollar-cost or per-model token aggregation** — model is captured and
  displayed; cross-model rollups/pricing are not built here.
- **Web design beyond the agreed ceiling** — no theming, dark mode, component
  library, responsive layout, layout framework, nav, or token sparkbars.
- **AI summarization** — still out, per the Trace PRD.

## Open Questions

None.
