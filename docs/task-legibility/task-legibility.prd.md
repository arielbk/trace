# PRD: Task legibility and re-enter prompt

## Problem Statement

The Trace board and task detail pages are dominated by machine-facing text:
every task row repeats its title as a kebab-case slug, carries a truncated
UUID chip that copies a value nothing in the workflow accepts, and repo group
headers render full absolute paths. The detail page squeezes title,
description, slug, and UUID into one dense header, and session/doc entries
show long transcript paths. Meanwhile the one human-facing field that exists —
the task description — is never shown on the board at all. Separately, getting
an agent back into a task requires the user to type a re-enter request from
memory, and the CLI skill verbs resolve tasks only by exact case-sensitive
title, which is both brittle and the root cause of agents creating tasks with
kebab-case "titles".

## Solution

A declutter-and-reorient pass governed by one rule: plain-language information
only; identifiers earn their place by being used. Descriptions replace slugs on
board rows, UUIDs disappear entirely, paths display compactly while copying
their full values, and every task offers a one-click copyable re-enter prompt
("Re-enter the trace task \"Title\" (slug)") from both the board and the detail
page. Underneath, CLI skill-verb resolution becomes slug-canonical with a
normalized title fallback, and slug-shaped titles are humanized
deterministically at creation so kebab-case titles stop being minted.

## User Stories

1. As a Trace user scanning the board, I want each row to show the task title
   and a one-line description instead of a slug and UUID, so that I can
   recognise tasks by what they are about.
2. As a Trace user, I want repo group headers to show `~`-collapsed paths that
   still copy the full absolute path, so that headers stay readable without
   losing the copyable value.
3. As a Trace user on the board, I want a hover row-action that copies a
   re-enter prompt, so that I can glance, grab, and paste into an agent
   without clicking through to the task.
4. As a Trace user on a task detail page, I want a visible copy-prompt button
   in the header, so that resuming the task in a fresh session is one click.
5. As a Trace user pasting the copied prompt into a fresh Claude Code session,
   I want the agent to bind to exactly the right task, so that re-entry never
   guesses or mismatches.
6. As an agent invoking the trace skill, I want to resolve a task by its slug
   as the canonical ref, so that resolution is exact and quoting/casing of
   titles never matters.
7. As an agent passing a human title instead of a slug, I want a normalized
   (trimmed, case-insensitive) exact title fallback, so that existing
   title-based invocations keep working.
8. As an agent whose ref matches nothing, I want the failure output to list
   near candidates, so that I (or the recall skill) can do the fuzzy part
   without the CLI growing matching semantics.
9. As a user whose agent passes a slug-shaped string as a new task title, I
   want the title humanized deterministically at creation (the original string
   becomes the slug), so that kebab-case titles stop appearing on the board.
10. As a Trace user on the detail page, I want session and doc entries to show
    compact filenames whose chips copy full paths, so that the timeline is
    readable but full values stay one click away.
11. As a Trace user, I want the task description rendered prominently on the
    detail page and as a clamped single line on board rows, so that the most
    informative field is the most visible one.

## Implementation Decisions

- **Core: title humanization.** A pure function beside `slugify` detects
  slug-shaped input (`^[a-z0-9]+(-[a-z0-9]+)*$`) and converts it to a
  sentence-case title ("break-stop-and-stale-expiry" → "Break stop and stale
  expiry"). Applied inside task creation in the store so every caller
  benefits; the original slug-shaped string seeds the slug. Composes with the
  in-flight change that rejects UUID-shaped slugs at allocation.
- **CLI: skill verb resolution.** `work-on-task` and `re-enter` resolve a ref
  in order: existing ref resolution (id, then slug exact) → normalized-exact
  title (trimmed, case-insensitive). On no match, `re-enter` fails with a
  short plain-text list of near candidates (no matching semantics — fuzzy
  resolution stays in the recall skill); `work-on-task` proceeds to create.
  The store's existing `getTaskByRef` is the substrate; no schema changes.
- **Web: re-enter prompt builder.** One pure function produces
  `Re-enter the trace task "Title" (slug)`, shared by board rows and the
  detail header. The slug rides along in the copied text as the exact hook
  even though it is no longer displayed anywhere.
- **Web: board page.** Remove UUID chips and slug lines from rows; render the
  description as a one-line CSS-clamped muted line under the title (rows
  without a description show the title alone). Repo group headers display
  `~`-collapsed paths; the chip copies the full absolute path. The copy-prompt
  action joins archive as a quiet hover row-action per the existing
  hover-swap pattern (no reserved space, no transitions).
- **Web: detail page.** Header keeps title, description, and token summary;
  slug text and UUID chip are removed; the copy-prompt button takes the freed
  slot as the primary visible action. Session entries keep tool icon, model
  chip, token breakdown, and relative time; transcript chips display the
  filename only and copy the full path. Doc entries display filename only.
- **Skill doc.** One-line nudge that `work-on-task` titles should be
  human-readable sentence case; re-enter examples updated to show slug as the
  canonical ref.

## Testing Decisions

- Unit tests for the humanization function and its application at task
  creation (slug-shaped title in → humanized title out, original string as
  slug), following the existing core store test patterns.
- CLI tests for skill verb resolution order (slug hit, normalized title hit,
  miss with candidate list) following the existing CLI skill test patterns.
- Unit test for the re-enter prompt builder (exact output shape).
- Web changes are verified visually; the web app has no component-test
  harness and this feature does not introduce one.

## Out of Scope

- Fuzzy matching in the CLI — vague references remain the recall skill's job.
- Migrating or renaming existing kebab-titled tasks (handled by hand once).
- Any detail-page redesign beyond the shared declutter rules.
- Changes to the recall skill or the re-entry manifest format.
- Codex entry points (deferred upstream).
