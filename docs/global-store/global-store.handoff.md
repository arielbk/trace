# Global Store — Verification Handoff

Context handoff for a fresh agent. The global-store human verification is
**done and passing**; what remains is an optional deeper exercise of the task
**timeline / token aggregation** on the detail page. Everything you need is below.

---

## Status so far (2026-05-29)

All four human-verification checks PASS — recorded in
[`global-store.qa.md`](./global-store.qa.md) → "Human verification run".

| Check | Outcome |
|-------|---------|
| First-run bootstrap creates `~/.trace/trace.sqlite`, exits 0 | ✅ (clean temp HOME + real `~/.trace`) |
| `task create` stamps git root, not cwd | ✅ |
| Web reads global store with `TRACE_DB` unset | ✅ |
| Web groups tasks by project root | ✅ |

Also closed during the run:
- **`drizzle-kit` watch item** — ran on host: `check` → "Everything's fine",
  `generate` → "No schema changes". Hand-authored migration matches `schema.ts`.
- **PRD-deviation fix (code, uncommitted):** path resolution was duplicated in
  `apps/cli/src/db-path.ts` and `apps/web/src/server/data.ts`. Extracted
  `resolveDatabasePath(env)` into `packages/core/src/db-path.ts`, exported from
  `@trace/core`, both consumers now delegate (public names unchanged).
  `pnpm -r check-types` clean, `pnpm -r test` **30/30**.

### Artifacts
`docs/global-store/qa-artifacts/` — `global-store-web.webm` (recording),
`global-store-grouped.png`, `global-store-task-detail.png`, `README.md`.

### Uncommitted changes (nothing committed yet)
```
M apps/cli/src/db-path.ts          # delegates to core
M apps/web/src/server/data.ts      # delegates to core
M packages/core/src/index.ts       # exports resolveDatabasePath
?? packages/core/src/db-path.ts    # new shared helper
?? docs/global-store/qa-artifacts/ # artifacts
?? docs/global-store/*.md          # prd/qa/handoff docs
```

---

## What's NOT yet exercised (the next step)

The task **detail page** (`apps/web/src/pages/TaskPage.tsx`) shows
`Total tokens / Input / Output` and a **timeline** of sessions + docs. The two
existing smoke tasks have **no sessions or docs attached**, so the page
correctly shows `0 / 0 / 0` and "No timeline items found". That's not a bug —
it just hasn't been fed any data.

**Goal:** attach a few agent sessions (with token counts) and a doc to a task,
then confirm the detail page aggregates tokens and lists timeline items in
created-at order. This exercises `getTaskTimeline` /
`registerSession` / `assignSession` / `addTaskDoc` end-to-end through the web.

### Current store state (`~/.trace/trace.sqlite`)
```
b2466bc0-60ca-4a37-8a39-5dbf0d8fdb67   project_root=/Users/arielbk/Projects/side/trace-v2   "global-store smoke A (nested subdir)"
4ffc6b97-eb37-4ba5-abc6-c0ccee4e3dd9   project_root=/Users/arielbk/tmp-trace-repo-b          "global-store smoke B (other repo)"
```
(Use `task list` to re-fetch IDs in case they changed.)

### Ready-to-run commands

Run from repo root. `TRACE_DB` must stay **unset** so the CLI and web share
`~/.trace/trace.sqlite`. Node 24 runs the `.ts` CLI directly. (`export
_ZO_DOCTOR=0` silences a harmless zoxide shell-init warning.)

```bash
cd /Users/arielbk/Projects/side/trace-v2
export _ZO_DOCTOR=0
TASK=b2466bc0-60ca-4a37-8a39-5dbf0d8fdb67   # task A; re-check with: node apps/cli/src/trace.ts task list
RUN() { env -u TRACE_DB node apps/cli/src/trace.ts "$@"; }

# Session 1 — a Claude turn with full token breakdown (total auto-sums to 4400)
RUN session register --id demo-claude-1 --transcript /tmp/demo-claude-1.jsonl --tool claude \
  --input-tokens 1200 --output-tokens 800 \
  --cache-creation-input-tokens 400 --cache-read-input-tokens 2000
RUN session assign demo-claude-1 "$TASK"

# Session 2 — a Codex turn (total 2100)
RUN session register --id demo-codex-1 --transcript /tmp/demo-codex-1.jsonl --tool codex \
  --input-tokens 600 --output-tokens 1500
RUN session assign demo-codex-1 "$TASK"

# A doc on the task (timeline mixes sessions + docs, sorted by createdAt)
RUN task add-doc "$TASK" docs/global-store/global-store.prd.md

# Expected aggregate on the detail page: Total 6500 · Input 1800 · Output 2300
# and 3 timeline items (2 sessions + 1 doc).
RUN task timeline "$TASK" --json    # sanity-check the numbers before opening the web UI
```

> There's also a one-shot `skill work-on-task <taskId> --id ... --transcript ... --tool ...`
> that registers + assigns in a single call, but it passes **empty** token
> totals — use `session register` (above) when you want non-zero tokens.

### View it in the web app
```bash
cd apps/web && env -u TRACE_DB _ZO_DOCTOR=0 pnpm dev    # http://localhost:3000/
# Click "global-store smoke A" → detail page should now show 6500 / 1800 / 2300
# and the timeline list.
```

### Capture — REQUIRED: record a video + screenshot
The user wants a screen **recording** of this (not just screenshots). Use the
`agent-browser` skill (load it first); `ffmpeg` is already installed. Record the
flow showing the detail page with non-zero token totals and a populated timeline:
```bash
agent-browser record start docs/global-store/qa-artifacts/global-store-timeline.webm
agent-browser open http://localhost:3000/
agent-browser wait --text "2 tasks"
agent-browser find text "global-store smoke A" click
agent-browser wait --text "6500"            # confirms the aggregated total rendered
agent-browser wait 1500                       # hold on the populated timeline for the video
agent-browser screenshot --full docs/global-store/qa-artifacts/global-store-timeline.png
agent-browser record stop                     # -> global-store-timeline.webm
```
Then verify the output is a real video, not an empty file:
```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \
  docs/global-store/qa-artifacts/global-store-timeline.webm   # should be > 0
```
Gotchas seen last time: a `record start` that fails (e.g. ffmpeg missing)
leaves recording state "active" — run `record stop` once to clear before
re-starting. `record stop` reports "No frames captured" if ffmpeg wasn't
running when it started. `.webm` is vp8; convert to mp4/gif with ffmpeg if you
want native Finder preview.

### Things worth checking while you're in there
- **Timeline ordering** — items sort by `createdAt`, ties broken by a stable
  key (`compareTimelineItems` in `packages/core/src/store.ts`). With sessions
  registered seconds apart the order should be deterministic.
- **`registerSession` idempotency** — re-registering the same `--id` returns the
  existing row (no duplicate). Worth a quick confirm.
- **Token total math** — `totalTokens` defaults to the sum of the four
  component counts when `--total-tokens` isn't passed; the page's "Total" is the
  sum across all assigned sessions.

### Cleanup notes
- `~/tmp-trace-repo-b/` was deleted; its task row keeps the old `project_root`
  string by design (PRD: no move/rename reconciliation).
- `~/.trace/credentials.json` is unrelated/pre-existing — **do not delete**.
- The demo sessions/docs above persist in `~/.trace/trace.sqlite`. There's no
  `task delete` CLI command; to reset, remove rows via
  `/usr/bin/sqlite3 ~/.trace/trace.sqlite "DELETE FROM ..."` or delete
  `~/.trace/trace.sqlite*` (the WAL/SHM files too) to start fresh.

### Open decision for the user
- Commit the `@trace/core` refactor + docs on a branch? (Nothing committed yet.)
- The web UI is functional but unstyled — out of scope for this slice per PRD.
