# PRD: Session Registration Gap

## Problem Statement

Some Claude Code sessions never get registered in the trace store, so their token usage and timeline presence are silently lost. Concrete evidence from 2026-06-03: a live session in `trace-v2` had its transcript on disk at `~/.claude-infinum/projects/-Users-arielbk-Projects-side-trace-v2/0e92b9b0-8cb7-40e1-8a66-73520cf148b9.jsonl`, but no corresponding row in `~/.trace/trace.sqlite` — the newest registered session for that project was `1d752647…` from earlier in the day. The unregistered session began via `/clear` from a prior session, which is the leading suspect: the SessionStart hook may not fire (or may fail) for `clear`-sourced session starts, or the hook may have errored silently.

## Solution

Diagnose why the SessionStart hook missed this session, fix the registration path so all session-start sources (`startup`, `clear`, `resume`, `compact` — whatever the hook matrix actually is) register reliably, and make failures observable instead of silent. `trace session scan` already exists as a backfill primitive; it should be able to recover sessions that slipped through.

## User Stories

1. As a trace user, I want every Claude Code session registered in the store regardless of how it started, so that token accounting is complete.
2. As a trace user, I want hook registration failures to be observable (logged somewhere inspectable), so that gaps are noticed when they happen, not weeks later.
3. As a trace user, I want `trace session scan` to find and backfill transcripts that exist on disk but are missing from the store, so that historical gaps are recoverable.

## Implementation Decisions

- Reproduce first: start sessions via fresh launch, `/clear`, and `--resume`, and check which produce store rows. Inspect the hook's stdin payload for the `source` field across these cases.
- Audit the session-start hook for silent failure modes (non-zero exits swallowed, store-open errors, project-dir mismatches across `~/.claude` vs `~/.claude-infinum` config homes — note the unregistered transcript lives under `.claude-infinum`).
- Fix belongs in the hook/adapter layer in the core package; the scan/backfill path should share the same registration code so the two can't drift.

## Testing Decisions

- Adapter-level unit tests covering each SessionStart `source` value, following the existing claude-code-adapter test patterns.
- A regression test for the specific failure mode found during diagnosis.

## Out of Scope

- Codex session registration (unless diagnosis shows a shared cause).
- Retroactive token recomputation beyond what `session scan` already does.

## Open Questions

- Does the SessionStart hook fire at all for `/clear`-sourced starts in the current Claude Code version, or does it fire with a payload the hook mishandles?
- Are multiple Claude config homes (`~/.claude` and `~/.claude-infinum`) a factor in which sessions get hooked?
