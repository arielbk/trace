# QA Plan: Core Deepening

## What was built

Five behavior-preserving refactors that concentrate scattered logic in `@trace/core` and the CLI into deep, single-home modules: a `TokenTotals` value module (`token-totals.ts`), one `TranscriptAdapter` per tool behind a registry (`transcript-adapter.ts` + `transcript-messages.ts`), a `session-identity.ts` owning the env→session contract, a dual-source `task-docs.ts` (DB-registered + native docs merge), and an extracted `trace init` installer (`apps/cli/src/installer.ts`) with the SessionStart hook now sourcing identity from core. No observable behavior should change — these are pure deepening refactors aimed at testability and AI-navigability.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not action.

- [x] `pnpm --filter @trace/core test` — core suite green at every slice: 31/31 after `token-totals`, 34/34 after `transcript-adapters`, 45/45 after `session-identity` (11 new tests), 48/48 after `task-docs` (3 new tests).
- [x] `pnpm --filter @trace/cli test` — CLI suite green throughout: 24/24 through the core slices, then 30/30 after `cli-installer-split` added `installer.test.ts` (4 tests) + `claude-hook-identity.test.ts` (2 tests).
- [x] `pnpm check-types` (root, turbo `tsc --noEmit` per package) — both `@trace/core` and `@trace/cli` typecheck clean after every slice.
- [x] `pnpm lint` (root, turbo `eslint . --max-warnings 0` per package) — clean after every slice (core lint clean each iteration; CLI lint clean after `cli-installer-split`).
- [x] New `token-totals` unit tests — cover `emptyTokenTotals`/`addTokenTotals`/`tokenTotalsFromUsage`, including the `total ?? sum-of-parts` derivation and snake_case/camelCase usage keys.
- [x] New `session-identity` unit tests — drive `inferSessionIdentity` with Codex (`CODEX_THREAD_ID`), Claude (`CLAUDE_CODE_SESSION_ID` + legacy `CLAUDE_SESSION_ID`/`session_id` fallbacks), and transcript-path synthesis.
- [x] New `task-docs` unit tests — cover `mergeTaskDocs` dedup-by-path (registered wins) and createdAt→path ordering without standing up SQLite.
- [x] `installer.test.ts` — drives `runInit` directly against a temp HOME (no CLI spawn): writes settings, idempotent on re-run.
- [x] `claude-hook-identity.test.ts` — in-process SessionStart hook → `session register` round-trip, plus the missing-`session_id` guard.

## Human verification required

Every slice is `done` with `Human checkpoint: no`, and no slice was left `needs-review` — the unit/type/lint gates above were all self-verified. What the isolated loop iterations could **not** exercise is the end-to-end runtime behavior these refactors are meant to preserve: a real `trace init` writing to a real `~/.claude/settings.json`, the SessionStart hook firing inside an actual Claude Code session, and the CLI commands reading real transcripts on disk. Walk the hero loop below to confirm observable behavior is unchanged.

### Setup

The `trace` CLI is already linked globally (`/Users/arielbk/Library/pnpm/bin/trace`, runs `apps/cli/src/trace.ts` directly under Node 24). If a teammate is on a fresh checkout, link it first:

```bash
cd /Users/arielbk/Projects/side/trace-v2
pnpm install
pnpm link --global        # puts `trace` on PATH
```

These checks touch your real `~/.claude/settings.json` and the trace store (`~/.trace`, or `$TRACE_DB` if set). To avoid disturbing your live config, point them at a scratch HOME/DB, e.g. `TRACE_DB=/tmp/trace-qa.db trace ...` and inspect a copy of settings.json rather than your daily one.

- [ ] **`trace init` is idempotent and wires the SessionStart hook**
  - Run (against a scratch HOME so your real config is untouched):
    ```bash
    HOME=/tmp/trace-qa trace init
    HOME=/tmp/trace-qa trace init   # run a second time
    ```
  - Open: `/tmp/trace-qa/.claude/settings.json`
  - Do: inspect the `hooks.SessionStart` array after each run.
  - Expect: first run adds exactly one SessionStart hook pointing at the trace hook entry; second run is a no-op (no duplicate hook, no error). This is the path most reshaped by `cli-installer-split` (logic moved into `installer.ts`).

- [ ] **SessionStart hook records a real Claude Code session via the lifted identity seam**
  - Run: with `trace init` applied to your real `~/.claude/settings.json`, start a brand-new Claude Code session in any repo, then:
    ```bash
    trace session list --unassigned
    ```
  - Expect: the new session appears in the list with `tool: claude` and a sensible transcript path. This confirms the hook now resolving identity through core `inferSessionIdentity` (instead of the old inline tool-string) still registers sessions correctly — the key `cli-installer-split` + `session-identity` integration point.

- [ ] **Hero loop: bind → drop a doc → re-enter (same-tool)**
  - Do: in a Claude Code session, tell the agent "We're working on <some task>"; note the reported `taskDocsDir`. Write a file into it (e.g. `decisions.md`). Then `/clear` and tell a fresh agent "Re-enter <that task>".
  - Expect: the re-entry manifest lists the task header, the decision doc you dropped in, and the prior session flagged `mostRecent: true`. Confirms `task-docs` (dual-source merge of DB-registered + native docs) surfaces the native doc with correct ordering.

- [ ] **`trace session tail <session-id>` returns the message tail for both tools**
  - Run: `trace session tail <a-claude-session-id>` and, if you have one registered, `trace session tail <a-codex-session-id>`.
  - Expect: a readable tail of recent messages (role + text), newest activity at the end, no crash on either tool. Confirms the per-tool `TranscriptAdapter` registry (`transcript-adapters`) reads real transcripts identically to before.

- [ ] **`trace session scan --codex` still lists Codex sessions**
  - Run: `trace session scan --codex` (point at a real Codex thread dir if needed).
  - Expect: Codex sessions are discovered and listed as before. `scanCodexSessions` was deliberately left as a free codex-only export outside the adapter interface — confirm that decision didn't change scan output.

## Watch closely

The slices were behavior-preserving, but each carried a deviation worth extra scrutiny during the runbook above — these are the likeliest sources of a subtle regression:

- [ ] **`token-totals` — usage normalization merge.** `tokenTotalsFromUsage` subsumes the store's former `normalizeTokenTotals` (which took camelCase `Partial<TokenTotals>`); `RawTokenUsage` now accepts both snake_case and camelCase. Adapters accumulate via `addTokenTotals(acc, tokenTotalsFromUsage(usage))` per event (vs the old in-place `addUsage`). Watch token totals in `session tail`/manifest output for off-by-one or dropped-field regressions, especially mixed-casing transcripts.
- [ ] **`transcript-adapters` — unified `parse(expectedId)` signature.** Codex maps `expectedId` to `expectedThreadId`; Claude ignores it. Confirm Codex id/thread matching still behaves correctly when an expected id is/ isn't supplied.
- [ ] **`session-identity` — three CLI helpers collapsed into one `inferSessionIdentity`.** Legacy Claude-id fallback order (`CLAUDE_CODE_SESSION_ID` → `CLAUDE_SESSION_ID` → `session_id`) and the `${tool}:${id}` transcript-path synthesis now live only here. Verify the SessionStart hook and `skill work-on-task` still resolve identity exactly as before, including the `--id`/`--transcript`/`--tool` override flags.
- [ ] **`cli-installer-split` — `??` fallbacks in the hook register call.** Register args use `identity.id ?? input.session_id` / `identity.transcriptPath ?? input.transcript_path`. The log states these never actually fall back (overrides are passed verbatim, guards already narrowed the inputs) — confirm the registered session id/transcript match the hook's stdin exactly, with no surprise substitution.
