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
