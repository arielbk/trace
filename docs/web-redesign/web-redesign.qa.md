# QA Plan: Web Redesign

## What was built

A visual and usability redesign of the two existing web pages (task list and task timeline): project-grouped task rows sorted newest-activity-first, compact token stats with a cache read/creation split, truncated click-to-copy IDs and paths, inline semantic type icons, and a CSS-custom-property theme with a persisted light/dark toggle. No information-architecture changes — the same data, presented better.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not action.

- [x] `pnpm --filter @trace/web test` — full web Vitest suite green (54 tests by the final slice: `format`, `theme`, `CopyChip`, `ThemeToggle`, `TasksPage`, `TaskPage`, `styles`, plus `truncatePath`).
- [x] `pnpm --filter @trace/core test` — full core store suite green (60 tests, incl. the new `listTaskSummaries()` sessions+docs and doc-only fallback cases).
- [x] `pnpm check-types` — TypeScript clean across `@trace/web` and `@trace/core` (imports resolve, `TaskSummary` widening typed).
- [x] `pnpm lint` — ESLint clean across both packages (`--max-warnings 0`).
- [x] `pnpm build` — production Vite bundle builds successfully (verified from the `theme-tokens-toggle` slice onward).
- [x] No-hardcoded-hex gate (`styles.test.ts`) — automated as a Vitest test: asserts no hex color exists outside the `:root` / `[data-theme="dark"]` custom-property blocks, plus light/dark palette completeness. Green.
- [x] Web data-adapter test exercises `listTaskSummaries()` end-to-end against a real SQLite store — the exact result `GET /api/tasks` returns (covers the API path structurally; see Watch closely re: the skipped live `curl` smoke).

## Human verification required

Every item below is a runtime/GUI gate the agent could not self-verify: this repo's Vitest runs in the **node** environment with no `jsdom`/`happy-dom`, so click → clipboard → confirmation, theme rendering, and hover tooltips all need a real browser. The slices `theme-tokens-toggle`, `copy-chip`, `tasks-page-redesign`, and `task-page-redesign` are all at `Status: needs-review` for exactly this reason.

### Setup

Run once. The Vite dev server also mounts the API (via `traceApiPlugin`), so a single command serves both the pages and `GET /api/tasks` on the same port.

```bash
cd apps/web
pnpm install        # only if dependencies aren't already installed
pnpm dev            # serves the app + API on http://localhost:3000
```

To reach a task timeline (`/task/{id}`), open the list at `http://localhost:3000/` and click any task row — that navigates to its `/task/{id}` URL. Pick a task that has real activity (sessions/docs) so the stat cards and timeline are populated. All items below assume the Setup server is running.

- [ ] **Light/dark theme toggle** (slice `theme-tokens-toggle`, `Human checkpoint: yes`)
  - Open: `http://localhost:3000/` and a `http://localhost:3000/task/{id}` page.
  - Do: click the header theme toggle on each page; then reload the page; then in DevTools clear `localStorage` key `trace.theme` and toggle your OS appearance (light/dark) before a fresh load.
  - Expect: both pages render correctly and legibly in **both** themes (no unstyled/invisible text, no clashing colors); the toggle flips the whole page instantly; with no stored override the **OS preference wins** on first visit; after toggling, the override **survives a reload** (no flash of the wrong theme on load). Content is centered with a sane max-width, not hugging the left edge.

- [ ] **Click-to-copy chip — clipboard + confirmation** (slice `copy-chip`, flipped to `needs-review`; interactive path untested, see Watch closely)
  - Open: a `http://localhost:3000/task/{id}` page.
  - Do: hover the short ID chip in the header; then click it; then paste (Cmd-V) into any text field.
  - Expect: hovering shows the **full 36-char UUID** in the native tooltip (`title`); clicking shows a brief **"Copied"** confirmation that **auto-clears after ~1.2s**; the pasted value is the full UUID, not the 8-char truncation.

- [ ] **Tasks list — grouping, sorting, copy, untitled fallback** (slice `tasks-page-redesign`, `Human checkpoint: yes`)
  - Open: `http://localhost:3000/`.
  - Do: scan the groups and rows; hover a row's compact token total; click a row's short ID chip and a project path chip, pasting each afterward.
  - Expect: tasks are grouped under prominent **project headers** (basename prominent, full path muted/mono and copyable); rows within a group are sorted **newest-activity-first**, and groups themselves are ordered by their single most recent activity (liveliest project + most recent task float to the top); a task whose title is a raw UUID renders the distinct **"Untitled task"** fallback style (human-titled tasks do not); token totals read compactly (e.g. `16.3M`) with the **exact integer on hover**; clicking the row's short ID copies the full UUID and clicking the project path chip copies the full path.

- [ ] **Task timeline — stat cards, cache split, icons, paths** (slice `task-page-redesign`, `Human checkpoint: yes`)
  - Open: a `http://localhost:3000/task/{id}` page for a task with real activity.
  - Do: read the five header stat cards and hover each; scan the timeline entries; hover and click a transcript/doc path chip, pasting afterward.
  - Expect: header shows the title plus a copyable short ID; **five** compact stat cards — Total, Input, Output, **Cache read**, **Cache creation** — each with the exact integer on hover; the headline **Total reconciles** against Input + Output + Cache creation + Cache read (see Watch closely for the one expected exception); each timeline entry leads with an inline **SVG type icon** (claude = sparkle, codex = `</>`, doc = page) correctly colored in both themes; timestamps render **relative** (e.g. `3m ago`) when recent, never as raw ISO strings; paths render as their **tail segment** with the full path on hover and click-to-copy yielding the full path.

## Watch closely

Log entries recorded these deviations and caveats — the most likely sources of subtle issues during human verification.

- [ ] **`copy-chip` interactive path was never exercised** — the agent flipped this slice to `needs-review` despite its `Human checkpoint: no`, because an offline `pnpm add -D happy-dom` failed (not in local store, no network AFK), so the click → `navigator.clipboard.writeText` → "Copied" → auto-clear path has zero automated coverage. The static contract (truncated display, full value in `title`, accessible button) *is* unit-tested. Scrutinize the clipboard/confirmation behavior, especially in browsers where `navigator.clipboard` requires a secure context.
- [ ] **Stat-card reconciliation on Codex sessions** — the UI assumes `total = input + output + cacheCreation + cacheRead`. Codex sessions can carry a provider-supplied `total_tokens` that may not sum exactly. If a card's Total doesn't match its parts, that's the upstream data source, **not** a UI bug (per the `task-page-redesign` handoff).
- [ ] **Live `GET /api/tasks` smoke was skipped AFK** (slice `task-summaries-api`, settled `done`) — the `curl localhost:3000/api/tasks` smoke could not run with no live dev server. The path is covered structurally by the web data-adapter test against a real SQLite store, but a quick `curl http://localhost:3000/api/tasks` (server from Setup) to confirm each task carries `lastActivityAt` and `tokenTotals` is a cheap belt-and-suspenders check.
- [ ] **`CopyChip` is a `<button>` nested as a sibling of row `<Link>`s, never inside them** — a button inside an anchor is invalid HTML and the chip does not `stopPropagation`. `tasks-page-redesign` follows the sibling pattern; confirm clicking a row's copy chip copies and does **not** also navigate into the task.
