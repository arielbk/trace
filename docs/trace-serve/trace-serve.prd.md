# PRD: `trace serve`

## Problem Statement

To see their tasks in the web UI today, a user has to **clone the repo** and run
the Vite dev server. The `/api/tasks` endpoints the web app depends on don't come
from a real server — they're a Vite dev-server middleware (`apps/web/src/server/api-plugin.ts`)
that only exists while `vite dev` is running. That clone-and-run step is
unacceptable friction for the testers we're about to hand Trace to.

## Solution

Add a `trace serve` subcommand to the CLI that already ships inside the Claude
Code plugin. It starts a plain Node HTTP server that serves the built web assets
plus the existing `/api/tasks` endpoints, reading from `~/.trace/trace.sqlite` —
the same database the CLI already reads for task CRUD. A plugin user runs
`trace serve` (no clone, no npm), the browser opens, and their live task board
appears.

Distribution piggybacks on the plugin bundle that already ships the `trace` CLI.
No npm publish, no standalone distribution channel — the audience is Claude Code
plugin users, and they already have the CLI.

## User Stories

1. As a Trace plugin user, I want to run `trace serve` and have my task board open
   in the browser, so that I can see my tasks without cloning the repo.
2. As a Trace plugin user, I want `serve` to read my real `~/.trace/trace.sqlite`,
   so that the board reflects my actual sessions and tasks.
3. As a Trace plugin user, I want `serve` to pick a free port and tell me the URL
   (and open it for me), so that I don't have to think about ports.
4. As a Trace plugin user, I want to stop the server with Ctrl-C, so that the
   lifecycle is obvious and I'm not babysitting a background process.
5. As a contributor, I want `vite dev` to keep working exactly as it does now, so
   that local web development is unaffected.
6. As a contributor, I want the dev middleware and the shipped server to share one
   request handler, so that the two paths can't drift apart.

## Implementation Decisions

- **Shared API handler.** Extract the `/api/tasks` request-handling logic out of
  the Vite plugin into a single framework-agnostic handler function (plain
  `req`/`res`, no Vite types). The Vite dev middleware calls it (dev unchanged);
  the new `serve` command calls it too. The data functions in `server/data.ts`
  (`listTaskSummaries`, `getTaskTimeline`, `getDatabasePath`) are reused as-is.

- **`serve` command.** A new subcommand on the existing CLI dispatcher. Starts a
  plain `node:http` `createServer` — no Express or other framework. Routes:
  static file requests served from the bundled web assets; `/api/tasks*` routed to
  the shared handler. SPA fallback: unknown non-API paths return `index.html` so
  client-side routing works.

- **Static assets in the bundle.** `vite build` produces `apps/web/dist`. The CLI
  build step (`apps/cli/src/build.ts`) copies that dist into the plugin alongside
  the bundled `trace.js`, in a location `serve` resolves relative to its own
  bundle directory at runtime.

- **Port and browser.** Default to a fixed port; if taken, fall back to the next
  free one. Print the resolved URL and auto-open the browser.

- **Lifecycle.** `serve` runs in the foreground until Ctrl-C. The user starts it
  themselves in their own terminal. The plugin skill's job is to instruct the user
  to run `trace serve` and surface the URL — it does **not** spawn, track, or kill
  a background server.

- **Data layer.** Unchanged. `serve` reuses the same SQLite access path the CLI
  already exercises for task CRUD, so there's no new native-dependency risk.

## Testing Decisions

- **Shared handler** is the deep module to test in isolation: given a seeded
  temp SQLite DB (prior art exists in `apps/web/src/__tests__/data.test.ts` and
  the `*-crud` tests, which already build temp `trace.sqlite` fixtures), assert
  `GET /api/tasks` returns the task summaries and `GET /api/tasks/:id/timeline`
  returns the timeline or 404.
- **`serve` static/SPA routing**: assert a known asset path and that an unknown
  non-API path falls back to `index.html`.
- **Build step**: assert the web `dist` lands in the plugin bundle location that
  `serve` resolves (extends the existing `bundle.test.ts` / build tests).
- The Vite dev path needs no new tests beyond confirming it still wires the shared
  handler.

## Out of Scope

- Publishing the CLI to npm / `npx trace serve`.
- Any standalone (non-plugin) distribution.
- A skill-managed background server (PID tracking, double-start guards, teardown).
- Reworking the `vite dev` workflow or the data layer.
- Auth, multi-user, or remote (non-localhost) serving.
