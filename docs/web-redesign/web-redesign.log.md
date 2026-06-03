# Web Redesign — Implementation Log

## `format-utils` — 2026-06-03 17:44:08

**Status:** done
**Summary:** Added `apps/web/src/format.ts` with three pure helpers — `formatTokensCompact` (M/K abbreviation, sub-1K verbatim), `formatRelativeTime` (just now / m / h / d ago, absolute date beyond a week), and `truncateId` (UUID → first 8 chars, non-UUID passthrough) — plus a 16-case Vitest suite in `format.test.ts`. Full web suite (21 tests), typecheck, and lint all green.
**Deviations:** none.
**Handoff:** Key decisions downstream slices depend on:
- `truncateId` only truncates strings matching a strict UUID regex; anything else is returned unchanged. This is load-bearing for `tasks-page-redesign`'s "untitled fallback" — a raw-UUID title will truncate, a human title will not. The `copy-chip` slice should pass the full value separately from the displayed (truncated) value rather than relying on truncateId for display of arbitrary strings.
- `formatRelativeTime(iso, now?)` takes an optional `now` Date (defaults to `new Date()`) purely to keep it testable; production callers omit it. Future timestamps and sub-minute diffs both render `"just now"`.
- The absolute-date fallback (`"May 20, 2026"`) is computed from **UTC** date parts for test determinism across timezones. If a downstream design wants local-date display, that's a deliberate change, not an oversight.
- Module is DOM/React-free by design — safe to import from both pages and the copy-chip component.

## `task-summaries-api` — 2026-06-03 18:00:31

**Status:** done
**Summary:** Added a `TaskSummary` type (`Task` + `lastActivityAt` + `tokenTotals`) and a `listTaskSummaries()` method on the `TaskStore` interface, implemented in `NodeSqliteTaskStore` by reusing the existing refresh-on-read `listSessionsForTask`/`listDocsForTask` paths: `lastActivityAt` is the max of all session/doc `createdAt` with `task.createdAt` as the reduce seed (so it falls back to creation time and can never precede it), and `tokenTotals` aggregates the refreshed per-session totals via `addTokenTotals`. Exposed it through the web data adapter (`listTaskSummaries`) and switched `GET /api/tasks` to return summaries instead of bare tasks. Two new core store tests (sessions+docs case, doc-only fallback case) and one web data-adapter test. Full core suite (60) and web suite (22) green; typecheck and lint clean across both packages.
**Deviations:** none material. The slice's `curl localhost:3000/api/tasks` smoke could not run AFK (no live dev server), but the API handler returns the exact `listTaskSummaries()` result that the web data-adapter test already exercises end-to-end against a real SQLite store, so the path is covered structurally — no runtime-only gate remained, hence `done` rather than `needs-review`.
**Handoff:** Key decisions downstream slices depend on:
- `GET /api/tasks` now returns `TaskSummary[]`, a **superset** of the old `Task[]` (every prior field plus `lastActivityAt` and `tokenTotals`). `tasks-page-redesign` can fetch this directly — no extra round-trip needed for per-row relative time or compact token totals. `TasksPage.tsx` currently types the fetch result as `Task[]`; that slice should widen it to `TaskSummary` (exported from `@trace/core`).
- `listTaskSummaries()` preserves `listTasks()` ordering (`created_at ASC, id ASC`) — it does **not** sort newest-activity-first. The "sort rows newest-activity-first within each group" requirement in `tasks-page-redesign` is the page's job, using the new `lastActivityAt` field.
- `tokenTotals` here is the per-task **session** aggregate (docs carry no tokens), matching `getTaskTimeline().tokenTotals`. The cache-split fields (`cacheCreationInputTokens`, `cacheReadInputTokens`) are present on every summary, so the list view can show a compact total while `task-page-redesign` shows the full reconciliation.
- `lastActivityAt` is a plain ISO string ready for `formatRelativeTime` from the `format-utils` slice.

## `copy-chip` — 2026-06-03 18:15:09

**Status:** needs-review
**Summary:** Added `apps/web/src/components/CopyChip.tsx` — `<CopyChip value={full} display={truncated} />` renders the truncated `display` inside a `<button class="copy-chip">`, exposes the full `value` via the native `title` tooltip, and on click copies `value` with `navigator.clipboard.writeText` then shows a brief "Copied" status (auto-clears after 1.2s; timer cleaned up on unmount). Landed it on the TaskPage header, replacing the raw 36-char `<p className="task-id">{id}</p>` with the 8-char copy chip via `truncateId(task.id)`. Added `.copy-chip` styles and a 3-case component test plus a TaskPage header integration test. Full web suite (26 tests), typecheck, and lint all green.
**Deviations:** Flipped to `needs-review` despite the slice's `Human checkpoint: no`. The static contract (truncated display, full value in `title`, accessible labelled button, TaskPage integration) is fully unit-tested via `renderToStaticMarkup`, but the slice's actual feedback loop is interactive-only (click → clipboard write → "Copied" confirmation appears/clears) and requires a real browser DOM. This repo's vitest runs in the **node** environment with no `jsdom`/`happy-dom` installed, and an offline `pnpm add -D happy-dom` failed (not in the local store; no network AFK), so the click/clipboard/confirmation path could not be exercised automatically. A human should click-verify per the slice's feedback loop.
**Handoff:** Key decisions downstream slices depend on:
- Public API is `CopyChip({ value, display })` from `apps/web/src/components/CopyChip.tsx`. The component does **not** truncate — callers pass the already-truncated `display` (use `truncateId` from `format.ts`) separately from the full `value`. This matches the `format-utils` handoff note: `truncateId` only shortens strict UUIDs, so for a human title `truncateId` returns it unchanged and the chip just shows it verbatim. `tasks-page-redesign` should pass `display={truncateId(task.id)}` for row IDs.
- The chip renders a `<button>`, so when nesting inside a clickable row/`<Link>` (e.g. `tasks-page-redesign`), guard against the click bubbling into navigation — the chip's own `onClick` does not currently `stopPropagation`. Add `e.stopPropagation()` at the call site or extend `CopyChip` if a row-level link wraps it.
- Confirmation is internal state with a 1.2s auto-clear timer; no external "copied" callback is exposed. If `task-page-redesign` wants path chips, reuse `CopyChip` as-is (`value={fullPath} display={truncatedTail}`).
- CSS uses the file's existing hardcoded-hex convention (`#fff`, `#475467`, `#1f6f5b`, etc.). The `theme-tokens-toggle` slice's grep for hardcoded hex will catch `.copy-chip` rules — they must be converted to custom properties as part of that slice.
