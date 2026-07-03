# QA Plan: Skeleton loaders & task-detail heading fix

## What was built

The task list (`TasksPage`) and task detail (`TaskPage`) pages now render a pulsing skeleton in the same slot as their eventual content while their query is in flight, then **cross-fade** (fade + cross-blur) into the real content once data arrives — replacing the bare `Loading...` strings. The cross-fade is driven by a small reusable `useSkeletonReveal(ready)` hook plus a `t-skel` CSS block (`--skel-*` tokens, pulse keyframes, reveal transitions) added to `index.css`, honoring `prefers-reduced-motion`. Separately, the task-detail header row was fixed so a long `h1` title wraps within itself and no longer pushes the "Last active …" time onto its own line.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not action.

- [x] `pnpm --filter @trace/web test` (or `pnpm test` in `apps/web`) — full web suite green, **238 tests across 19 files**, after all three slices.
- [x] `useSkeletonReveal.test.ts` — hook unit test with fake timers: reports loading while not-ready, flips to stacked/revealing when readiness turns true, and unmounts the skeleton layer after the 400ms reveal window.
- [x] `TasksPage.test.tsx` — asserts the row skeleton renders while the query is pending and the real `TaskRow` list renders after data arrives.
- [x] `TaskPage.test.tsx` — asserts the detail skeleton renders while loading and the real timeline content renders after; plus a structural regression guard that the header row no longer carries `flex-wrap` and the "Last active" text stays inside the heading row element.
- [x] `pnpm --filter @trace/web check-types` — TypeScript clean.
- [x] `pnpm --filter @trace/web lint` — ESLint clean (`--max-warnings 0`).
- [x] `pnpm --filter @trace/web build` — production Vite build succeeds (the >500kB chunk-size notice is pre-existing and unrelated).
- [x] Regression check on unrelated failures — the 3 failing tests in `apps/cli/src/bundle.test.ts` and `apps/cli/src/task-crud.test.ts` were confirmed pre-existing (fail identically on the pre-change tree via `git stash`); no web tests regressed.

## Human verification required

The cross-fade and the heading fix are **visual** — jsdom does no real layout or animation, so the tests above can only assert structure/state, not the actual motion. These need a browser.

### Setup

Run once from the repo root:

```bash
cd /Users/arielbk/Documents/side_projects/trace-v2
pnpm install        # only if dependencies are not already installed
pnpm --filter @trace/web dev
```

The dev server serves the app + API on `http://localhost:3000` (see `apps/web/vite.config.ts`). To make the skeleton easy to catch, throttle the network in DevTools (Network tab → "Slow 3G") or hard-reload so the query is genuinely pending for a moment.

- [ ] **List skeleton cross-fade** (slice `list-skeleton`)
  - Open `http://localhost:3000/` with the network throttled.
  - Expect: a set of ~6 pulsing row placeholders appears in the list slot (title bar + meta bars), the page title "Tasks" stays put, and when data lands the skeleton **cross-blurs/fades out** while the real rows fade in over ~400ms — one smooth motion, no blink or hard-swap, no layout jump. The subtitle and filter bar appear with the real content.

- [ ] **Detail skeleton cross-fade** (slice `detail-skeleton`)
  - From the list, open a task (or hit a `/tasks/:id` URL directly) with the network throttled.
  - Expect: a placeholder header + back-link + heading/description bars + ~4 timeline-row placeholders pulse in the content slot, then cross-fade into the real task header and timeline over ~400ms. Note: during the ~400ms overlap two page trees are briefly mounted (documented tradeoff) — confirm there's no visible flicker or duplicated header once the reveal settles.

- [ ] **Long-title heading pinning** (slice `heading-fix`)
  - Open a task whose title is long enough to wrap (create one if needed, e.g. a ~120-char title).
  - Expect: the `h1` wraps across multiple lines within its own column while the "Last active …" block stays pinned top-right **on the same row as the start of the heading**, not pushed onto a line below.

- [ ] **Reduced motion** (cross-cutting)
  - Enable "Reduce motion" (macOS: System Settings → Accessibility → Display → Reduce motion) and reload a loading page.
  - Expect: no pulse animation and no cross-blur transition — the skeleton is replaced by content without motion (the `prefers-reduced-motion` block disables the pulse/transition).

## Watch closely

- **`t-skel` mechanism deviates from the source skill snippet.** The `14-skeleton-reveal` skill's literal `.t-skel-skeleton`/`.t-skel-content { position: absolute; inset: 0 }` assumes a fixed-size card. Both pages have variable height (list row count / timeline item count), so instead only the **skeleton** detaches to an absolute overlay on reveal while the real (now-mounted) content stays in flow and drives height. Visual effect is identical; watch for any height collapse/jump at the moment of reveal, which is where this mechanism would show a seam.
- **Reveal duration is duplicated in two places.** `REVEAL_MS = 400` in `useSkeletonReveal.ts` must stay in sync with `--skel-reveal-dur: 400ms` in `index.css`. If one is changed without the other, the skeleton will either unmount before the fade finishes (visible pop) or linger after (dead frames).
- **Unrelated fix folded into `list-skeleton`.** Because `TasksPage` now renders `AppHeader` unconditionally (even mid-load) instead of returning an early bare `Loading...`, `ThemeToggle` now mounts during load and calls `window.matchMedia`; a `matchMedia` stub was added to `App.test.tsx` to match. Not a product behavior change, but noted since it touched a test outside the feature's obvious surface.
