# QA Plan: trace serve

## What was built

`trace serve` starts a bundled HTTP server that serves the Trace task board SPA and the live task APIs from the user's Trace SQLite store. The plugin bundle now ships the built web assets, and the Trace skill points users at the terminal-owned serve command.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not action.

- [x] `pnpm --filter @trace/cli test -- src/serve.test.ts` - serve listener, static asset, SPA fallback, port fallback, browser-open, and bundle asset resolution tests passed 11/11.
- [x] `pnpm --filter @trace/core test -- src/api-handler.test.ts` - shared `/api/tasks` and `/api/tasks/:id/timeline` handler tests passed 4/4.
- [x] `pnpm --filter @trace/cli test -- src/bundle.test.ts` - bundle asset copy and gitignore-safety tests passed 3/3.
- [x] `pnpm --filter @trace/cli test -- src/bundle.test.ts src/serve.test.ts` - combined bundle and serve suite passed 14/14.
- [x] `pnpm --filter @trace/cli test -- src/serve.test.ts src/trace.test.ts` - available serve CLI suite passed.
- [x] `pnpm --filter @trace/cli test -- src/repo-skill.test.ts` - skill prose regression tests passed 3/3.
- [x] `pnpm --filter @trace/cli test -- src/plugin-scaffold.test.ts` - plugin scaffold regression test passed 1/1.
- [x] `pnpm --filter @trace/web build` - web SPA build completed.
- [x] `pnpm --filter @trace/cli build` - bundled CLI and plugin assets built.
- [x] `pnpm --filter @trace/cli check-types` - CLI typecheck passed.
- [x] `pnpm --filter @trace/cli lint` - CLI lint passed.
- [x] `git check-ignore -v -- bin/web/index.html` - returned not ignored; bundled web asset destination is not hidden by `.gitignore`.

## Human verification required

Items from slices with `Human checkpoint: yes`, plus anything from the log that needs a human eye, browser, device, or judgement call. Each item is a runbook - exact commands, exact entry point, steps, and pass criterion. Never make the human figure out how to run the thing.

### Setup

Commands shared by the items below. Run once from the repo root. This uses the built plugin bundle and the default live store at `~/.trace/trace.sqlite`; if `127.0.0.1:4317` is busy, `trace serve` falls back through the next 10 ports and prints the actual URL.

```bash
cd /Users/arielbk/Projects/side/trace-v2
unset TRACE_DB
node bin/trace.js serve
```

Leave that terminal running. Use the printed line, normally `trace serve listening on http://127.0.0.1:4317/`, as the base URL for the checks below. Stop it with `Ctrl-C` after QA.

- [ ] **Live HTTP API accepts real socket traffic**
  - Run: use the server from Setup.
  - Open: `http://127.0.0.1:4317/api/tasks` in a browser, or run `curl -s http://127.0.0.1:4317/api/tasks` in a second terminal, replacing `4317` if Setup printed a fallback port.
  - Do: confirm the endpoint returns JSON, then open one returned task's timeline at `http://127.0.0.1:4317/api/tasks/<slug-or-id>/timeline`.
  - Expect: `/api/tasks` returns an array of live task summaries from `~/.trace/trace.sqlite`; the timeline endpoint returns that task's timeline JSON, or a 404 only if the task id/slug was typed incorrectly.

- [ ] **`serve-ui` needs-review: browser-rendered board loads correctly**
  - Run: use the server from Setup.
  - Open: `http://127.0.0.1:4317/`, replacing `4317` if Setup printed a fallback port.
  - Do: verify the browser either opens automatically or loads manually at the printed URL. Inspect the board, project grouping, task rows, copy chips, token totals, timestamps, and empty state if the store has no tasks.
  - Expect: the page shows the Trace header and a `Tasks` view backed by the live store, with no API errors, broken styling, missing assets, or obviously stale data.

- [ ] **`serve-ui` needs-review: client-side task route survives refresh**
  - Run: use the server from Setup.
  - Open: `http://127.0.0.1:4317/`, replacing `4317` if Setup printed a fallback port.
  - Do: click a task row to navigate to `/task/<slug>`, wait for the timeline page to load, then refresh the browser on that task URL.
  - Expect: the refreshed task URL still serves the SPA fallback and renders the same task timeline; it must not show a server 404, raw `index.html`, or a blank page.

- [ ] **Bundled server works when launched outside the repo checkout**
  - Run:
    ```bash
    cd /tmp
    unset TRACE_DB
    node /Users/arielbk/Projects/side/trace-v2/bin/trace.js serve
    ```
  - Open: the printed URL, normally `http://127.0.0.1:4317/`, replacing `4317` if the command prints a fallback port.
  - Do: load the board, then open `http://127.0.0.1:4317/assets/index-uMq6s6Q7.js` in a browser or with `curl -I`, replacing the port if needed.
  - Expect: the board loads from the bundled `bin/web` assets even though the current working directory is `/tmp`; the asset URL returns JavaScript with HTTP 200, not 404.

## Watch closely

Items where the log recorded deviations, snags, or unusual decisions. These are the most likely sources of subtle bugs - worth extra scrutiny during human verification.

- [ ] `serve-api` moved the shared API handler into `@trace/core`, not `apps/web`; confirm future changes do not accidentally fork request logic between Vite and `trace serve`.
- [ ] Unmatched `/api/...` paths now return 404 instead of falling through to Vite middleware; this is intentional but worth checking if any caller relied on SPA fallback under `/api`.
- [ ] Live `listen()` and browser/curl smoke checks were blocked in the implementation environment by `listen EPERM`; the human checks above are the first real socket verification.
- [ ] `serve-ui` was settled as `needs-review` only because it has `Human checkpoint: yes`; automated tests covered the injectable listener and fake server, not a real browser.
- [ ] `bundle-assets` structurally verified bundled asset resolution, but the no-repo live `bin/trace.js serve` smoke also needs a real socket check outside the sandbox.
- [ ] `apps/cli` has a pre-existing broken `test:bundle` script (`node --test src/bundle.test.ts` imports Vitest APIs); use `pnpm --filter @trace/cli test -- src/bundle.test.ts` for this suite unless that script is fixed separately.
