# Task Slugs — Implementation Log

## Decision: migrate vs dual-resolve

**Chosen: dual-resolve (no on-disk directory migration).**

Reasoning:
- Task doc directories live under `~/.trace/tasks/<id>/docs`. Moving them at
  migration time would mean filesystem renames driven by a DB migration, which
  is risky (partial failure leaves the store and disk inconsistent) and couples
  a schema migration to side effects on the user's home directory.
- Repo-side `docs/{feature}` → task-docs symlinks are created by following the
  `trace` skill prose, which points the symlink at whatever path the CLI prints
  as `taskDocsDir`. Existing symlinks already point at the UUID directory by
  absolute path, so they keep resolving even after we switch the printed path to
  the slug directory for new work.
- Dual-resolve keeps the change additive: new tasks get slug-named dirs; native
  doc listing checks the slug dir first and falls back to the legacy UUID dir,
  so historical docs remain visible without touching the filesystem.

Slug stays an addressing layer; UUID remains the stable primary key and the
fallback directory key, so nothing that already exists on disk breaks.

## Entries

- Slice 1 (slug utility): added `slug.ts` with `slugify` (NFKD transliterate,
  punctuation strip, kebab, 60-char cap at word boundary) and
  `generatePlaceholderSlug`. 11 unit tests green.
- Slice 2 (column + migration + backfill): added unique `slug` to schema/types,
  migration `0003_task_slug` (nullable column + unique index), and a store-side
  backfill that runs after migrations and derives slugs deterministically by
  creation order. `createTask` now derives + reserves a slug and allows empty
  titles (placeholder slug). Updated the two existing tests that read Task
  shape / old-schema migration.
- Slice 3 (resolver): added `getTaskByRef` (UUID then slug) and routed
  `getTaskTimeline`, `getReEntryManifest`, `addTaskDoc`, `assignSession`, and
  `listDocsForTask` through it. `getTask` stays an exact-id lookup.
- Slice 4 (slug dirs): `resolveTaskDocsDir` is a plain path builder; new tasks
  use the slug as the dir ref. `listNativeTaskDocs` takes ordered dir refs and
  returns the first non-empty one while always stamping the canonical task id,
  so `[slug, uuid]` gives slug-primary with legacy UUID fallback (dual-resolve).
- Slice 5 (CLI): `task create` and `task list` now emit the slug; `task show`
  prints `slug:` plus the UUID `id:`. `show`, `add-doc`, `timeline`, and the
  skill verbs resolve refs via `getTaskByRef`, so a slug works anywhere a UUID
  did. `skill work-on-task` prints a slug-named `taskDocsDir`. Rebuilt the
  bundled `bin/`/`dist/` CLI so the plugin-distributed binary carries the change.
- Slice 6 (web): `TaskList` shows + links by slug; `TaskPage` displays the slug
  and resolves through the already ref-tolerant `/api/tasks/:ref/timeline`
  endpoint, so slug URLs load. Updated web fixtures to carry `slug`.
