# QA Plan: Task legibility and re-enter prompt

## What was built

Decluttered the Trace board and detail pages (descriptions replace slugs, UUIDs removed, paths `~`-collapsed), added a copyable re-enter prompt to both pages and as a hover row-action on the board, made CLI skill-verb resolution slug-canonical with a normalized title fallback, and humanized slug-shaped titles at task creation.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not action.

- [x] `cd packages/core && pnpm test` — 108 tests pass (includes new tests for `looksLikeSlug`/`humanizeSlug`, `/api/config` route 200 + JSON, non-GET 405 guard on `/api/config`)
- [x] `cd apps/web && pnpm test` — 81 tests pass (includes 2 new `buildReEnterPrompt` unit tests in `format.test.ts`, `TasksPage` / `TaskPage` component tests)
- [x] `cd apps/cli && pnpm test` — 76 tests pass (includes 4 new `resolveSkillTaskRef` CLI tests: slug hit, normalized-title hit, miss-with-candidates, plus 1 prose test)
- [x] `pnpm lint` (workspace root, all packages via turbo) — 0 warnings, 0 errors; also resolved a pre-existing `@typescript-eslint/no-require-imports` violation in `apps/web/src/format.test.ts`
- [x] `pnpm check-types` (workspace root, all packages via turbo) — no type errors
- [x] `pnpm build` (workspace root) — full build with updated Turbo dependency ordering (`@trace/web` now declared in `apps/cli` devDependencies so web builds first); `bin/web` refreshed to `index-hA-mTFX7.js` / `index-wB_X22cx.css`

## Human verification required

One slice carries `Human checkpoint: yes` (`board-declutter`). The `board-copy-action` slice also explicitly flags that clipboard click interactions have no automated coverage and require a human eye.

**Verified by the user 2026-06-06 — all items below passed.**

### Setup

Start the Trace board server once; all items below share it.

```bash
node /Users/arielbk/.claude/plugins/cache/trace-v2/trace/0574bc05ffd9/bin/trace.js serve
# Prints something like: http://127.0.0.1:4317
# Use whatever port it prints — 4317 is the default; it picks the next free port if taken.
```

Leave this running in its own terminal for the duration of verification.

---

- [x] **Board rows show descriptions, not identifiers**
  - Open: `http://127.0.0.1:4317` (or the port printed by `trace serve`)
  - Do: Look at the task rows in the board. For any task that has a description, confirm a one-line muted description renders beneath the title and is clamped (trailing ellipsis if long). For any task without a description, confirm only the title shows — no second line.
  - Expect: No kebab-slug text (e.g. `break-stop-and-stale-expiry`) visible anywhere in a row. No UUID chip on any row. Rows with descriptions show them; rows without do not show a blank line.

- [x] **Repo group headers show `~`-collapsed paths; chip copies the full path**
  - Open: `http://127.0.0.1:4317`
  - Do: Look at the group header(s) for tasks that belong to a repo. Confirm the path shown starts with `~` (e.g. `~/Projects/side/trace-v2`) rather than the raw absolute path (e.g. `/Users/yourname/...`). Click the path chip to copy it, then paste into a text editor.
  - Expect: The header displays a `~`-collapsed path. The pasted value is the full absolute path (e.g. `/Users/yourname/Projects/side/trace-v2`), not the tilde form.

- [x] **Board hover row-action: copy re-enter prompt**
  - Open: `http://127.0.0.1:4317`
  - Do: Hover over a task row. Confirm a copy icon appears (alongside the archive icon) in the right-hand action area without shifting the row's layout (no reserved space when not hovering). Click the copy icon. Paste the clipboard contents into a text editor.
  - Expect: The copy icon and archive icon appear together on hover with no layout jump. The pasted text is exactly: `Re-enter the trace task "Title" (slug)` — where Title and slug match that task. The icon briefly swaps to a check-mark after clicking to confirm the copy.

- [x] **Archive action still works alongside copy action**
  - Open: `http://127.0.0.1:4317`
  - Do: Hover a task row. Click the archive icon (not the copy icon). Confirm the task is archived (disappears from the active board or moves to an archived section).
  - Expect: Archiving still works as before; the copy action's presence does not break it.

- [x] **Detail page: copy re-enter prompt button**
  - Open: `http://127.0.0.1:4317`
  - Do: Click through to any task's detail page. Look at the header area.
  - Expect: The header shows: title on the left with "Copy re-enter prompt" chip on the same row (right-aligned), description directly below the title (when present), and token summary beneath. No slug text. No UUID chip. Click "Copy re-enter prompt" and paste into a text editor — the text must be `Re-enter the trace task "Title" (slug)`.

- [x] **Re-enter prompt binds to the correct task in a Claude session**
  - Open: `http://127.0.0.1:4317`, navigate to any task with a recognizable title
  - Do: Copy the re-enter prompt from either the board hover action or the detail page header. Open a fresh Claude session (new conversation). Paste the prompt and send it.
  - Expect: The agent recognizes the task reference and binds to the correct task (asks about or resumes that specific task by title/slug). This verifies the prompt format is functional end-to-end, not just cosmetically correct.

## Watch closely

- **CSS recovery after accidental `git checkout`** (`board-declutter` review cycle): The agent accidentally ran `git checkout apps/web/src/styles.css` mid-session, wiping uncommitted board CSS (`.task-row-description`, `.task-row-slug` removal). It recovered by extracting the pre-revert build from Turbo cache and diffing selectors. The final CSS was confirmed clean by a full selector diff, but this is the highest-risk edit in the run — scrutinize the board row styling in particular (description line, no slug line, hover action layout) and compare against the pass criteria above.

- **Turbo build-ordering fix** (`board-declutter` review cycle): `apps/cli` was missing `"@trace/web": "workspace:*"` in devDependencies, causing `bin/web` to stay stale when only web changed. The dependency was added and the build verified end-to-end. If `trace serve` shows unexpected old UI, re-run `pnpm build` from the repo root to confirm `bin/web` is current.

- **`apps/cli` `test:bundle` script is pre-existing broken** (`slug-resolution`): `test:bundle` (`node --test src/bundle.test.ts`) fails under Node's runner because `bundle.test.ts` imports vitest. This was noted as pre-existing and out of scope. `pnpm test` (vitest) passes fine; only the `test:bundle` alias is broken. No action required unless bundle testing is needed independently.
