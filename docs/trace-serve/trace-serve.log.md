# trace serve — implementation log

## `serve-api` — 2026-06-04 00:06:51

**Status:** done
**Summary:** Extracted the `/api/tasks` and `/api/tasks/:id/timeline` routing out of the Vite plugin into one framework-agnostic router, `handleTraceApiRequest(databasePath, method, url)`, plus a `writeTraceApiResponse(sink, response)` helper — both in `@trace/core` (`packages/core/src/api-handler.ts`, exported from the index). The Vite dev middleware (`apps/web/src/server/api-plugin.ts`) now mounts unscoped and calls that shared router. Added `apps/cli/src/serve.ts` (`createServeRequestListener` / `createTraceServeServer` / `startTraceServe`) driving a `node:http` server through the same router, and wired `trace serve` into `runTraceCli` (handled early, before the synchronous store block, like `init`).

**Deviations:**
- The shared handler lives in `@trace/core`, not in `apps/web`. Reason: the CLI's `trace serve` and the web Vite plugin both need it, and the bundler (`apps/cli/src/build.ts`) only special-cases `@trace/core` + relative imports — putting it in core means both consumers reach it with zero cross-app imports, no new package deps, and no tsconfig changes. The slice said "extract out of api-plugin.ts"; the routing logic was extracted and relocated to the genuinely-shared package.
- Unmatched `/api/...` paths now return 404 instead of the Vite plugin's old `next()` fall-through. The two working endpoints behave identically; only never-handled API paths changed (404 is more correct than serving the SPA).
- `trace serve` request-routing is unit-tested by driving `createServeRequestListener` with a fake req/res (no socket). The actual `listen()` could not be exercised here — see Handoff.

**Handoff:**
- **Socket bind is blocked in this environment.** `node http listen` returns `listen EPERM` (verified even with sandbox disabled and on a minimal one-liner) — an OS/sandbox restriction, not a code defect. I confirmed the full command chain works by running the *built* bundle `node apps/cli/dist/trace.js serve`: it routes through `runTraceCli` → `startTraceServe` → `listen` and fails only at the EPERM bind, printing `trace serve failed: listen EPERM ...`. So the wiring is proven; only the live socket accept + `curl` is unverified. A human (or a non-sandboxed CI machine) should do the manual `curl localhost:4317/api/tasks` check. `startTraceServe(env, { port })` accepts a port override (`{ port: 0 }` for ephemeral) for any future live test.
- Default port is `DEFAULT_SERVE_PORT = 4317` in `apps/cli/src/serve.ts`. **`serve-ui` owns port fallback-if-taken, printing the URL, browser auto-open, static-asset serving, and SPA fallback.** Right now `startTraceServe` rejects on `EADDRINUSE` (no fallback) and any non-API path 404s — both intentional placeholders for `serve-ui` to replace. The serve request listener's `if (!response) → 404` branch is exactly where SPA/static fallback should slot in.
- The router contract for downstream slices: `handleTraceApiRequest` returns `{ status, body, contentType? }` for any `/api/...` path, or **`null`** when the path is not an API request — that `null` is the signal for the HTTP host to fall through to static/SPA handling. `serve-ui` should branch on `null` rather than re-parsing the URL.
- `apps/web/src/server/data.ts` still exists and is still used by the Vite plugin (`getDatabasePath()`); its `data.test.ts` is untouched and passing.
- `apps/cli` `test:bundle` script (`node --test src/bundle.test.ts`) is pre-existing-broken — `bundle.test.ts` imports `describe/it` from `vitest`, so it only runs under `vitest run` (where it passes). Not in my lane; left alone.

---

## `serve-ui` — 2026-06-04 00:34:38

**Status:** needs-review
**Summary:** Reclaimed the orphaned `serve-ui` slice and verified the existing implementation serves the built SPA from `apps/web/dist` when available, falls back to `index.html` for unknown non-API paths, rejects path traversal outside the assets directory, falls back from the default port to the next free port, prints the resolved URL from `trace serve`, and launches the default browser best-effort after the server starts. The CLI bundle was rebuilt so `apps/cli/dist/trace.js` and `bin/trace.js` include the `serve` command wiring.
**Deviations:** Settled as `needs-review` because the slice has `Human checkpoint: yes`; the actual browser-rendered task board and refresh-on-task-route behavior still need a human/runtime check outside the socket-restricted sandbox. Live `listen()`/browser smoke could not be run here because this environment rejects Node HTTP binds with `EPERM`, so socket behavior was covered through the injectable listener and fake server.
**Handoff:** Feedback run: `pnpm --filter @trace/cli test -- src/serve.test.ts` passed 10/10; `pnpm --filter @trace/core test -- src/api-handler.test.ts` passed 4/4; `pnpm --filter @trace/cli check-types` passed; `pnpm --filter @trace/web build` passed; `pnpm --filter @trace/cli build` passed; `pnpm --filter @trace/cli lint` passed; `pnpm --filter @trace/cli test -- src/serve.test.ts src/trace.test.ts` passed the available serve suite. `bundle-assets` still owns copying web assets into the plugin bundle and resolving them relative to that bundle at runtime.
