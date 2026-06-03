# Web Redesign

Visual and usability redesign of the two existing web pages (task list, task timeline): project-grouped sorted task rows, compact token stats with cache split, truncated copyable IDs/paths, semantic icons, and a CSS-custom-property theme with a persisted light/dark toggle. No information-architecture changes.

## Slices

### `format-utils` — Pure formatting utilities

**Status:** done

**Outside-in:** `apps/web/src/format.ts` exporting `formatTokensCompact(n)` (`16317514` → `"16.3M"`, `81123` → `"81.1K"`, `<1000` verbatim), `formatRelativeTime(iso, now?)` (`"3m ago"`, `"2d ago"`, readable date beyond ~a week), and `truncateId(id)` (UUID → first 8 chars). Consumed by both pages and the copy-chip component.

**Feedback loop:** Vitest unit tests in `apps/web` covering edge cases: 0, <1K, exactly 1000, exactly 1M, rounding boundaries, future timestamps, just-now, non-UUID input to `truncateId`.

**Human checkpoint:** no

**Depends on:** none

### `task-summaries-api` — Task list enriched with last activity and token totals

**Status:** done

**Outside-in:** `GET /api/tasks` returns, per task, the existing fields plus `lastActivityAt` (max of session/doc `createdAt`, falling back to task `createdAt`) and aggregated `tokenTotals`, computed by a new store query (e.g. `listTaskSummaries()`) on the `TaskStore` interface in `packages/core`.

**Feedback loop:** Store unit test in `packages/core/src/task-store.test.ts` style: task with sessions and docs reports correct `lastActivityAt` and summed totals; task with neither falls back to `createdAt` and zero totals. Smoke: `curl localhost:3000/api/tasks` shows the new fields. Existing store suite stays green.

**Human checkpoint:** no

**Depends on:** none

### `theme-tokens-toggle` — CSS custom properties with light/dark toggle

**Status:** needs-review

**Outside-in:** `styles.css` rebuilt on CSS custom properties (palette, spacing, type scale) with light and dark palettes; a header toggle component on both pages initialized from `prefers-color-scheme`, override persisted in `localStorage`; page layout centered with sane max-width so content no longer hugs the left edge.

**Feedback loop:** Manual browser check at `localhost:3000`: both pages render correctly in both themes, toggle flips instantly, OS preference wins on first visit, override survives reload. No hardcoded hex colors remain outside the custom-property definitions (grep check).

**Human checkpoint:** yes

**Depends on:** none

### `copy-chip` — Shared click-to-copy component

**Status:** needs-review

**Outside-in:** `<CopyChip value={full} display={truncated} />` component: renders the truncated form, full value in `title`, copies the full value to the clipboard on click with a brief confirmation affordance. First landed on the TaskPage header replacing the raw 36-char task UUID with its 8-char form.

**Feedback loop:** Manual: hover shows full ID, click then paste yields the full UUID, confirmation affordance appears and clears. Truncation itself is already unit-tested in `format-utils`.

**Human checkpoint:** no

**Depends on:** format-utils

### `tasks-page-redesign` — Project-grouped, sorted, scannable task list

**Status:** needs-review

**Outside-in:** TasksPage groups tasks under prominent project headers (name prominent, path muted and copyable), sorts rows newest-activity-first within each group, and renders each row as title, short copyable ID, relative last-activity, and compact token total. Tasks whose title is a raw UUID render a distinct "untitled" fallback style.

**Feedback loop:** Manual browser check at `localhost:3000/`: groups ordered and styled per PRD, the most recently active task sits on top, an untitled task shows the fallback, token counts read compactly with exact value on hover, row ID click-copies the full UUID.

**Human checkpoint:** yes

**Depends on:** format-utils, task-summaries-api, copy-chip, theme-tokens-toggle

### `task-page-redesign` — Timeline with stat cards, cache split, and icons

**Status:** not-started

**Outside-in:** TaskPage header shows title plus copyable short ID; stat cards show Total/Input/Output **and** cache read/cache creation, compact with exact integers on hover, so the headline numbers reconcile. Timeline entries carry inline SVG type icons (claude, codex, doc), readable timestamps (relative when recent), and transcript/doc paths truncated to their tail with full path on hover and click-to-copy.

**Feedback loop:** Manual browser check at `localhost:3000/task/{id}` on a real task: cache tokens visible and stats reconcile against the total, each entry type shows its icon, no raw ISO strings or full paths render, path click-copy pastes the full value.

**Human checkpoint:** yes

**Depends on:** format-utils, copy-chip, theme-tokens-toggle
