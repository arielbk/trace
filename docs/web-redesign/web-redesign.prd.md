# PRD: Web Redesign

## Problem Statement

The trace web UI is functionally complete but hard to use. The task list renders as a flat column of links jammed against the left edge, every task and session is identified by a full 36-character UUID, project groups are barely distinguishable from task rows, token counts render as raw integers (`16317514`), and the headline numbers are actively misleading — a task shows Total 16.3M against Input 81K because cache tokens (the bulk of the total) are never rendered. There is no visual hierarchy, no iconography, and no way to tell at a glance which task was recently active.

## Solution

A full visual and usability redesign of the existing two pages — task list and task timeline — without changing the information architecture. Tasks are grouped under clear project headers and sorted by last activity. Rows show what you need to pick a task at a glance: title, short ID, relative last-activity, compact token total. IDs and paths are truncated with click-to-copy for the full value. Token stats are compact (`16.3M`) with exact values on hover and the cache read/creation split surfaced. Inline SVG icons mark types (claude session, codex session, doc) in the timeline. The palette is rebuilt as CSS custom properties with a light/dark toggle that defaults to the OS preference and persists.

## User Stories

1. As a trace user, I want tasks grouped under prominent project headers, so that I can navigate by project without reading file paths.
2. As a trace user, I want task rows sorted by last activity (newest first) within each project, so that the task I was just working on is at the top.
3. As a trace user, I want each task row to show title, short ID, relative last-activity time, and compact token total, so that I can pick the right task at a glance.
4. As a trace user, I want long UUIDs truncated to 8 characters with click-to-copy for the full value, so that the UI is readable but I can still paste IDs into CLI commands.
5. As a trace user, I want transcript and doc paths truncated to their meaningful tail (filename) with the full path on hover and click-to-copy, so that timeline entries are scannable.
6. As a trace user, I want token counts formatted compactly (`16.3M`, `81.1K`) with the exact integer on hover, so that magnitudes are parseable.
7. As a trace user, I want the task page stats to include cache read and cache creation tokens alongside Total/Input/Output, so that the headline numbers reconcile and I see where tokens actually went.
8. As a trace user, I want timeline entries marked with semantic icons (claude session, codex session, doc) instead of text-only badges, so that I can scan entry types visually.
9. As a trace user, I want timeline timestamps shown as readable date/time with relative phrasing for recent entries, so that I don't parse raw ISO strings.
10. As a trace user, I want tasks whose title is a raw UUID (untitled tasks) rendered with a distinct "untitled" fallback style, so that IDs never masquerade as titles.
11. As a trace user, I want a light/dark theme toggle in the header that defaults to my OS preference and persists my override, so that the app matches my dark desktop.
12. As a trace user, I want the page layout properly centered with sane max-width and spacing, so that content doesn't collapse against the left edge.

## Implementation Decisions

- **Task-summaries API.** The tasks list endpoint currently returns only id/title/createdAt/projectRoot. Enrich it (or add a summaries variant) with per-task last-activity timestamp and aggregated token totals, computed in the store layer by joining sessions (and docs for last activity). This is the only backend change.
- **Format utilities module.** Pure functions: compact token formatting, relative time formatting, ID truncation. Shared by both pages; the natural unit-test surface.
- **Theme tokens.** Rebuild the stylesheet on CSS custom properties (color palette, spacing, type scale) with light and dark palettes. Toggle component: two effective states, initialized from `prefers-color-scheme`, override persisted in `localStorage`. No settings page.
- **Click-to-copy component.** One shared component for IDs and paths: renders the truncated form, full value in `title`, copies full value on click with a brief confirmation affordance.
- **Icon set.** Inline SVGs only — claude, codex, doc type marks (plus small utility glyphs as needed). No icon-library dependency. Icons appear only where they encode a type.
- **Page redesigns.** TasksPage: project group headers (name prominent, path muted/copyable), sorted rows, untitled fallback. TaskPage: header with title + copyable ID, compact stat cards including cache split, timeline with icon-marked entries.
- **No router or page additions.** The two existing routes are the complete surface.

## Testing Decisions

- Unit tests for the format utilities (compact tokens, relative time, truncation) — pure functions with clear edge cases (0, <1K, exactly 1M, future timestamps).
- Unit test for the store task-summaries query (last activity and totals across sessions/docs), following the existing store test patterns in the core package.
- No UI snapshot or visual regression tests. Verification is a manual screenshot walkthrough of both pages in both themes at `localhost:3001` against the complaint list.

## Out of Scope

- New pages, navigation, dashboards, or project detail views.
- Project links, filters, or editor deep-links — project headers are presentation only.
- Human-readable task slugs (separate PRD: `docs/task-slugs/`).
- Decorative iconography or an icon-library dependency.
- Session counts on task rows.
- Manual theme scheduling, per-page theming, or a settings page.
