# trace serve

Ship the web task board inside the plugin bundle so a plugin user runs `trace serve` — no repo clone, no npm — and sees their live board from `~/.trace/trace.sqlite`. See `trace-serve.prd.md`.

## Slices

### `serve-api` — `trace serve` boots an HTTP server with the real API

**Status:** done

**Outside-in:** `trace serve` starts a `node:http` server; `GET /api/tasks` and `GET /api/tasks/:id/timeline` return live data. Extract the request logic out of `apps/web/src/server/api-plugin.ts` into one framework-agnostic handler, and rewire the Vite dev middleware to call that same handler (no logic fork).

**Feedback loop:** Unit test the shared handler against a seeded temp `trace.sqlite` (prior art: `apps/web/src/__tests__/data.test.ts`, `*-crud` tests). Manually: `trace serve`, then `curl localhost:<port>/api/tasks` returns real summaries; `vite dev` still serves `/api/tasks` unchanged.

**Human checkpoint:** no

**Depends on:** none

### `serve-ui` — Browser shows the task board

**Status:** needs-review

**Outside-in:** `trace serve` serves the built web SPA: static assets from `apps/web/dist`, with SPA fallback (unknown non-API paths return `index.html`). Picks a default port, falls back if taken, prints the URL, auto-opens the browser.

**Feedback loop:** Run `trace serve` against a dev-built `apps/web/dist`, browser opens to the task board reading `~/.trace/trace.sqlite`; client-side route to a task page works on refresh. Automated: assert a known asset path serves and an unknown non-API path falls back to `index.html`.

**Human checkpoint:** yes — eyeball the board renders correctly

**Depends on:** serve-api

### `bundle-assets` — Web assets ship in the plugin bundle

**Status:** done

**Outside-in:** The CLI build (`apps/cli/src/build.ts`) copies `apps/web/dist` into the plugin alongside the bundled `trace.js`; `serve` resolves the assets relative to its own bundle directory at runtime (not the repo).

> ⚠️ **Gitignore landmine:** the copy destination must NOT be named `dist` or `build` — both are bare patterns in `.gitignore` and match any such directory anywhere, so the committed assets would be silently dropped. Copy to e.g. `bin/web/` and ensure it's committed (`git check-ignore -v <path>` should return nothing).

**Feedback loop:** Run the bundled `bin/trace.js serve` from a directory with no repo checkout present — assets and API both load. Extend the build/bundle tests (`bundle.test.ts`) to assert the assets land at the resolved location and that the destination is actually tracked by git.

**Human checkpoint:** no

**Depends on:** serve-ui

### `serve-skill` — Plugin skill points the user at `trace serve`

**Status:** done

**Outside-in:** A plugin skill instructs the user to run `trace serve` and surfaces the URL. It does not spawn, track, or kill the server — the user runs it in their own terminal and stops it with Ctrl-C.

**Feedback loop:** Invoke the skill in a fresh Claude Code session; it outputs the run instruction and the URL. No background process is left behind.

**Human checkpoint:** no

**Depends on:** serve-api
