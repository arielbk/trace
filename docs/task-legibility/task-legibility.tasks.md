# Task legibility and re-enter prompt

Declutter the Trace board and detail pages (descriptions replace slugs, UUIDs
gone, paths compact), add a copyable re-enter prompt to both pages, make CLI
skill-verb resolution slug-canonical with a normalized title fallback, and
humanize slug-shaped titles at creation. Governing rule: plain-language info
only; identifiers earn their place by being used. PRD:
`docs/task-legibility/task-legibility.prd.md`.

## Slices

### `humanize-titles` — Humanize slug-shaped titles at creation

**Status:** done

**Outside-in:** `trace skill work-on-task "break-stop-and-stale-expiry"` creates a task titled "Break stop and stale expiry" with slug `break-stop-and-stale-expiry`; non-slug-shaped titles pass through unchanged.

**Feedback loop:** Core unit tests beside the existing store tests: slug-shaped title in → humanized title + original string as slug; ordinary title in → unchanged; composes with the UUID-shaped-slug rejection already in the working tree.

**Human checkpoint:** no

**Depends on:** none

### `slug-resolution` — Slug-canonical skill verb resolution

**Status:** done

**Outside-in:** `trace skill re-enter <slug>` resolves exactly; `trace skill re-enter "Title"` falls back to normalized-exact title (trimmed, case-insensitive); a miss fails with a short plain-text list of near candidates. `work-on-task` resolves the same way before creating. Skill doc: re-enter examples use slug as the canonical ref, plus a one-line nudge that titles should be human-readable sentence case.

**Feedback loop:** CLI tests beside the existing skill-verb tests: slug hit, normalized title hit, miss-with-candidates; no fuzzy semantics (vague refs remain the recall skill's job).

**Human checkpoint:** no

**Depends on:** none

### `detail-copy-prompt` — Detail header cleanup + copy re-enter prompt

**Status:** done

**Outside-in:** Task detail header shows title, description, token summary, and a visible "copy re-enter prompt" button — no slug text, no UUID chip. The button copies `Re-enter the trace task "Title" (slug)` via a shared pure prompt-builder function. Session transcript chips and doc entries display filename only; chips copy the full path.

**Feedback loop:** Unit test for the prompt builder's exact output (add a minimal vitest config to apps/web if none reaches it, or house the builder in a tested package — implementer's call). Manual: copy the prompt, paste into a fresh Claude session, confirm it binds to the right task (via title pre-`slug-resolution`, via slug after).

**Human checkpoint:** no

**Depends on:** none

### `board-declutter` — Board rows show descriptions, not identifiers

**Status:** done

**Outside-in:** Board rows render title plus a one-line CSS-clamped muted description (title alone when absent) — no slug line, no UUID chip. Repo group headers display `~`-collapsed paths; the chip still copies the full absolute path. The home dir for collapsing is sourced at runtime: a new `/api/config` route in `@trace/core` (added to `handleTraceApiRequest`) returns `{ home: os.homedir() }`, and `TasksPage` fetches it and passes `home` into `TaskList`. (Build-time `VITE_HOME` is wrong — the CLI serves a prebuilt static bundle.)

**Feedback loop:** Manual: board shows no kebab text and no UUIDs; rows with descriptions (the three newest tasks) show them clamped to one line; headers show `~`-collapsed paths and the chip pastes the full path. Plus a core unit test for the `/api/config` route (returns `{ home }` as JSON, 200) beside the existing api-handler tests.

**Human checkpoint:** yes

**Depends on:** none

### `board-copy-action` — Copy re-enter prompt as a hover row-action

**Status:** done

**Outside-in:** Hovering a board row reveals a copy-prompt action alongside archive, following the existing quiet hover-swap pattern (no reserved space, no transitions); clicking copies the same builder output as the detail page.

**Feedback loop:** Manual: hover a row, copy, paste into a fresh session — agent binds to that task; archive action still works beside it.

**Human checkpoint:** no

**Depends on:** detail-copy-prompt, board-declutter
