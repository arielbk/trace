# PRD: Task Slugs

## Problem Statement

Tasks are identified everywhere by UUIDs: in the web UI, in CLI output, and — most painfully — in on-disk paths like `~/.trace/tasks/271d0e57-0f84-4eaa-91f9-2b55570a898b/docs/`. UUIDs are unreadable, untypeable, and give no hint what a task is about. The web redesign papers over this with truncation and click-to-copy, but the underlying identity scheme is hostile to humans. Worse, a task created without a meaningful title shows its UUID as its display name.

## Solution

Give every task a human-readable kebab-case slug derived from its title (e.g. `manual-break-start-and-sounds`), unique within the store. Slugs become the primary human-facing handle: used in task directory paths, accepted by CLI commands wherever a task ID is accepted today, and displayed in the web UI. UUIDs remain the stable internal primary key — slugs are an addressing layer, not a replacement, so renames stay cheap and existing references don't break.

## User Stories

1. As a trace user, I want task directories named by slug (`~/.trace/tasks/manual-break-start-and-sounds/`), so that I can navigate the filesystem without a lookup table.
2. As a trace user, I want CLI commands to accept a slug anywhere they accept a task ID, so that I can type `trace task show manual-break-start-and-sounds`.
3. As a trace user, I want the web UI to show slugs instead of truncated UUIDs, so that tasks are identifiable at a glance.
4. As a trace user, I want slugs auto-derived from the task title at creation with collision handling (numeric suffix), so that I never have to invent one.
5. As a trace user, I want existing UUID-named task directories migrated (or at least newly-created tasks to use slugs with old paths still resolving), so that history isn't broken.

## Implementation Decisions

- Add a unique `slug` column to the tasks table; derive at creation from the title; suffix on collision. Slug is mutable (rename command later), UUID is not.
- CLI task-reference resolution becomes "try UUID, then slug" in one shared resolver.
- Task directory layout switches to slug-named dirs for new tasks; decide during implementation whether to migrate existing dirs (with store path updates) or dual-resolve. Repo-side doc symlinks (e.g. `docs/{feature}` → task docs dir) must keep working either way.
- Untitled tasks get a generated slug (`task-<short-id>`), which also fixes the UUID-as-title display problem at the root.

## Testing Decisions

- Unit tests for slug derivation (casing, punctuation, unicode, length caps) and collision suffixing.
- Store tests for slug uniqueness and the UUID-or-slug resolver.
- Migration test if directory migration is chosen.

## Out of Scope

- The web redesign's truncation/copy affordances (separate PRD; they remain useful for session IDs).
- Slugs for sessions or docs — tasks only.
- A task rename command (natural follow-up, not required here).
