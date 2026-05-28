# Global Trace Store

Move Trace from per-cwd / env-only DB paths to a global `~/.trace/trace.sqlite` default, with each task stamped by its project's git-root path so the web UI shows a cross-project view.

## Slices

### `global-default-path` — Global default DB path with first-run bootstrap

**Status:** done

**Outside-in:** Running any `trace` CLI command in a fresh shell with no `TRACE_DB` set creates and uses `~/.trace/trace.sqlite`.

**Feedback loop:** Integration test with `HOME` pointed at a tmp dir: `trace task list` exits 0, `~/.trace/trace.sqlite` exists and is a valid migrated DB. Unit test on the resolver: returns `TRACE_DB` when set, falls back to `~/.trace/trace.sqlite` when unset or empty.

**Human checkpoint:** no

**Depends on:** none

---

### `project-root-resolver` — Walk-up-to-git-root helper

**Status:** done

**Outside-in:** `resolveProjectRoot(cwd)` exported from `@trace/core` returns the nearest ancestor directory containing a `.git` entry, falling back to the input `cwd` if none is found.

**Feedback loop:** Unit tests with a fixture tree: cwd nested inside a `.git` repo resolves to the repo root; cwd outside any repo resolves to itself; cwd at the repo root resolves to itself.

**Human checkpoint:** no

**Depends on:** none

---

### `task-project-stamp` — Schema + CLI stamps and surfaces project root

**Status:** done

**Outside-in:** `trace task create "..."` stamps the new row with the resolved project root; `trace task show <id>` prints it.

**Feedback loop:** Drizzle migration runs cleanly against a fresh DB and against the existing schema. Store test: `createTask` populates `project_root`. CLI test: creating a task inside a fixture git repo, then `task show`, surfaces the repo root path.

**Human checkpoint:** no

**Depends on:** project-root-resolver

---

### `web-cross-project-view` — Web reads global store, groups by project

**Status:** done

**Outside-in:** Launching the web app with no env vars reads `~/.trace/trace.sqlite`; the task list page renders tasks grouped by project, with a display name derived from the project root path basename.

**Feedback loop:** `apps/web/src/__tests__/data.test.ts` extended to confirm the resolved global path is used when `TRACE_DB` is unset. Component/page test asserts grouping structure for a fixture with tasks from two project roots. Manual: launch web app, eyeball grouped list.

**Human checkpoint:** yes

**Depends on:** global-default-path, task-project-stamp
