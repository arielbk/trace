# Task Slugs — Slices

Vertical slices forming a DAG. Each ends green (test + lint + check-types in the
touched packages).

## Slice 1 — slug derivation utility (core)
**Depends on:** none
Pure function `slugify(title)` → kebab-case slug, plus `generatePlaceholderSlug(id)`
for empty titles (`task-<short-id>`). Handles casing, punctuation, unicode
transliteration/stripping, whitespace collapse, length cap, leading/trailing
dash trimming, empty-after-strip fallback.
**Feedback:** `pnpm --filter @trace/core test`, `lint`, `check-types`.

## Slice 2 — slug column + migration + backfill (core)
**Depends on:** 1
Add `slug` to `schema.ts` (unique), `types.ts` `Task.slug`, migration `0003`
in `migrations.ts` adding the column + unique index. Backfill existing rows in
`applyMigrations` (or via the store) deriving slugs from titles with collision
suffixing. `createTask` derives + persists a unique slug; empty title now allowed
and yields a placeholder slug. Migration test for old-schema DB gets slugs.
**Feedback:** core test/lint/check-types.

## Slice 3 — UUID-or-slug resolver in store (core)
**Depends on:** 2
Add `getTaskByRef(ref)` resolving UUID first then slug; route `getTask` callers
that accept human refs (timeline, manifest, addDoc, etc.) through it via a shared
private resolver. Keep `getTask(id)` as exact-id lookup. Store tests for
resolver (uuid, slug, miss) and slug uniqueness.
**Feedback:** core test/lint/check-types.

## Slice 4 — slug-named task directories (core)
**Depends on:** 2, 3
`resolveTaskDocsDir` keyed by slug for new tasks; decision documented in log
(dual-resolve vs migrate). Native doc listing resolves slug dir, falling back to
legacy UUID dir so old paths still resolve. `listDocsForTask` unaffected by ref
type.
**Feedback:** core test/lint/check-types.

## Slice 5 — CLI accepts slugs + prints slugs (apps/cli)
**Depends on:** 3, 4
Task commands (`show`, `timeline`, `add-doc`) resolve by UUID-or-slug. `task list`
and `task show` display slug. `task create` prints slug (keep id discoverable).
`skill work-on-task` prints slug-based `taskDocsDir`. Update affected CLI tests.
**Feedback:** `pnpm --filter @trace/cli test`, lint, check-types.

## Slice 6 — web shows slugs (apps/web)
**Depends on:** 2
Task type carries slug; `TaskList` shows slug instead of UUID and links by slug;
`TaskPage` resolves by slug via the timeline endpoint (already ref-tolerant) and
shows slug. Update web tests.
**Feedback:** `pnpm --filter web test`, lint, check-types.
