# PRD: Skeleton loaders & task-detail heading fix

## Resources

- Transition skill: `.agents/skills/transitions-dev/14-skeleton-reveal.md` — the `t-skel` cross-fade reveal (pulsing skeleton → cross-blur → content). Reference implementation for the CSS and state machine.
- Prior art for wiring these transitions: `apps/web/src/index.css` already hosts `t-icon-swap` and `t-success-check`, driven from React via `data-state` (`ArchiveToggleButton`, `TaskRow`, `CopyPromptButton`, `icons.tsx`). Follow the same convention.

## Problem Statement

Two rough edges in the web UI:

1. **Loading feels unfinished.** Both the task list (`TasksPage`) and the single task view (`TaskPage`) render a bare `Loading...` string while their query is in flight, then hard-swap to content. It reads as a placeholder that was never finished.
2. **Long titles shove the timestamp around.** On the task detail page the `h1` title and the "Last active …" time share a `flex flex-wrap justify-between` row. A long title consumes the full width and wraps the time onto its own line below the heading.

## Solution

1. Replace both `Loading...` strings with skeleton placeholders that use the `14-skeleton-reveal` transition: a pulsing skeleton in the same slot as the eventual content, which **cross-fades** (fade + cross-blur) into the real content once data arrives.
2. Constrain the title so a long `h1` no longer pushes the "Last active" time down — the time stays pinned on the same row.

## User Stories

1. As a user opening the task list, I want a skeleton of the rows while it loads, so the layout feels stable and intentional instead of blank.
2. As a user opening a task, I want a skeleton of the header + timeline while it loads, so I see the shape of the page immediately.
3. As a user, I want the skeleton to cross-fade into the real content (not blink/hard-swap), so the load reads as one smooth motion.
4. As a user viewing a task with a long title, I want the "Last active" time to stay on the heading row, so the header doesn't reflow awkwardly.

## Implementation Decisions

**Reveal mechanics — the core deep module.** react-query yields *no* content during `isLoading`, but the cross-fade needs both the skeleton and the real content mounted in the same slot for one reveal cycle. So the reveal is not "unmount skeleton the instant data lands." Extract a small reusable hook (e.g. `useSkeletonReveal(isReady)`) that:
- Returns state describing whether to render the skeleton layer and whether the wrapper is in the `revealed` state.
- While not ready: skeleton mounted, pulsing, wrapper at `loading`.
- When ready flips true: render content stacked over skeleton, toggle the wrapper to the revealed state so the skeleton fades/blurs out and content fades in over `--reveal-dur`, then unmount the skeleton layer after the reveal duration completes.
- The hook owns the timing/unmount so both pages stay declarative. Keep the interface tiny (input: readiness boolean; output: what to render + the wrapper state/attrs).

**CSS.** Add the `t-skel` block (wrapper + `.t-skel-skeleton` / `.t-skel-content` stacked layers, pulse keyframes, reveal transitions) and its `:root` reveal/pulse custom properties to `index.css`, matching the values in the transition skill and the existing transitions' house style. No external CSS.

**Skeleton shapes (bring-your-own bars).** Two distinct placeholder layouts, both sitting in the same slot as their real content:
- **List skeleton (`TasksPage`):** a handful of repeated row placeholders matching `TaskRow`'s footprint (title bar + project chip area), rendered inside the same list container.
- **Detail skeleton (`TaskPage`):** header block (title bar + "last active" line), optional description bar, and a few timeline-item placeholders approximating the timeline tree.

**Heading fix (`TaskPage`).** In the `flex flex-wrap items-start justify-between` header row, constrain the `h1` (cap its width / allow the title to wrap within itself) and keep the time non-shrinking so a long title no longer forces the "Last active" block to wrap to the next line. Purely a layout/Tailwind-class change; no behavior change.

## Testing Decisions

- **`useSkeletonReveal` hook** is the isolatable unit — worth a test: asserts it reports the loading state while not ready, transitions to a stacked+revealing state when readiness flips, and stops rendering the skeleton layer after the reveal window. Fake timers for the linger/unmount.
- Existing page tests (`TaskPage.test.tsx`, `TasksPage.test.tsx`) reference the `Loading...` copy — update them for the skeleton state (assert the skeleton placeholder renders while loading, real content after).
- The heading fix is visual; no unit test — just don't regress existing header tests.

## Out of Scope

- Skeletons for any view other than `TasksPage` and `TaskPage` (e.g. `DocViewerSheet`).
- A plain-swap / no-cross-fade fallback — the true cross-fade is the chosen behavior.
- Any new transition primitives beyond `t-skel`.
- The dropped second design tweak (deliberately cut during scoping).
