# Skeleton loaders & task-detail heading fix

Replace the bare `Loading...` strings on the task list and task detail pages with `14-skeleton-reveal` cross-fade skeletons, and stop a long task title from pushing the "Last active" time onto its own row.

## Slices

### `heading-fix` — Task-detail heading no longer shoves the time down

**Status:** done

**Outside-in:** `TaskPage` header row — a task with a long title renders with "Last active …" pinned on the same row as the `h1`, not wrapped below it.

**Feedback loop:** Manual: open a task with a very long title, confirm the "Last active" block stays on the heading row; confirm existing `TaskPage.test.tsx` header assertions still pass.

**Human checkpoint:** no

**Depends on:** none

### `list-skeleton` — Cross-fade skeleton for the task list (+ shared primitive)

**Status:** done

**Outside-in:** `TasksPage` while its query is pending renders a pulsing row skeleton in the list slot that cross-fades (fade + cross-blur) into the real `TaskRow` list once data arrives — replacing the `Loading...` string.

**Feedback loop:** Unit test for `useSkeletonReveal` (fake timers: reports loading while not-ready → stacked/revealing when readiness flips → skeleton layer unmounts after reveal window). Updated `TasksPage.test.tsx` asserting skeleton renders while loading and rows after. Manual: eyeball the cross-blur.

**Human checkpoint:** no

**Depends on:** none

### `detail-skeleton` — Cross-fade skeleton for the task detail page

**Status:** not-started

**Outside-in:** `TaskPage` while its query is loading renders a header + description + timeline skeleton that cross-fades into the real content once data arrives — replacing the `Loading...` string, reusing the `t-skel` CSS and `useSkeletonReveal` hook from `list-skeleton`.

**Feedback loop:** Updated `TaskPage.test.tsx` asserting the skeleton renders while loading and real content after. Manual: eyeball the cross-blur on a real task load.

**Human checkpoint:** no

**Depends on:** list-skeleton
