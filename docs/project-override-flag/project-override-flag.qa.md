# QA Plan: Project override flag

## What was built

A `--project <dir>` flag on every project-resolving trace CLI command (`task create`, `task capture`, `skill work-on-task`, `skill recall-candidates`): each now routes project resolution through a new `resolveProjectRootArg(projectArg, cwd)` helper in `@trace/core`, which defaults to the cwd-resolved project root, resolves a relative override against cwd, walks up to the override's git root, and hard-errors (exit 2, naming the path) on a nonexistent dir. The trace and recall skill docs were updated to teach the agent to pass `--project <dir>` when work lives in a different project than the CLI's working directory. This lets tasks created or recalled from a multi-project sandbox key to the real project root.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not action.

- [x] `pnpm --filter @trace/core test` — 105 tests pass (includes 5 new `resolveProjectRootArg` cases: no-flag → cwd; relative resolves against cwd; nonexistent throws; git-less existing dir returns the dir itself).
- [x] `pnpm --filter @trace/cli exec vitest run src/trace.test.ts` — 9 tests pass (3 for `task create`, 4 for `task capture` + `work-on-task`, 2 for `recall-candidates`; each covers override→other-repo root, no-flag preserves cwd behaviour, and nonexistent path exits non-zero naming the path).
- [x] `pnpm --filter @trace/core check-types` / `pnpm --filter @trace/cli check-types` — both clean.
- [x] `pnpm --filter @trace/core lint` / `pnpm --filter @trace/cli lint` (`--max-warnings 0`) — both clean (the now-unused `resolveProjectRoot` import was removed from `trace.ts` once `recall-candidates` was migrated).

## Human verification required

The three code slices are self-verified by the suites above. The remaining slice, `skill-docs-project-guidance`, is `Status: needs-review` with `Human checkpoint: yes`: its feedback loop is explicitly **manual** — copy-paste each documented invocation against a scratch repo and confirm it keys to the right project root, then review the agent-facing wording. The CLI integration tests exercised `runTraceCli` directly under vitest, so the documented commands have **not** been run end-to-end against the built bundle from an unrelated cwd; that is what these items cover.

### Setup

Run once, from the repo root (`/Users/arielbk/Projects/side/trace-v2`). These build the real CLI bundle the skill docs point at and create a throwaway git repo to key tasks against.

```bash
# Build the bundled CLI (writes bin/trace.js — the file the plugin docs reference)
pnpm --filter @trace/cli build

# Create a scratch project repo somewhere outside this repo
mkdir -p /tmp/qa-scratch && cd /tmp/qa-scratch && git init && cd -

# Stay in an UNRELATED cwd for the runs below (the repo root is fine — it is a
# different git root than /tmp/qa-scratch). The point is to prove --project
# overrides the cwd-resolved root.
```

- [ ] **`recall-candidates --project` scopes the pool to the override repo's root**
  - Run (from the repo root): `node bin/trace.js skill work-on-task "qa override probe" --id qa-smoke --transcript /tmp/qa.jsonl --project /tmp/qa-scratch`
  - Then run: `node bin/trace.js skill recall-candidates --project /tmp/qa-scratch`
  - Then run: `node bin/trace.js skill recall-candidates`
  - Expect: the task **"qa override probe"** appears in the `--project /tmp/qa-scratch` pool, and is **absent** from the plain `recall-candidates` run (which is scoped to the repo root's project). This confirms the documented invocations run against the bundle and key to the override repo.
- [ ] **Nonexistent `--project` is a hard error**
  - Run: `node bin/trace.js skill recall-candidates --project /tmp/does-not-exist-qa`
  - Expect: non-zero exit (2), with a message naming the bad path `/tmp/does-not-exist-qa`. (Repeat with `work-on-task ... --project /tmp/does-not-exist-qa` if you want to confirm the same behaviour there.)
- [ ] **Review the agent-facing wording (the actual contract)**
  - Open: `skills/trace/SKILL.md` (the `--project` paragraph under "We're working on X", after the env-var/`--model` note) and `skills/recall/SKILL.md` (step 1 "fetch the candidate pool", plus the step-3 note to pass the same `--project` to `work-on-task`).
  - Do: read both as if you were a fresh agent deciding whether to pass the flag.
  - Expect: the guidance is unambiguous — default to cwd; pass `--project <dir>` only when the work clearly lives in a different project than where the CLI runs; nonexistent path is a hard error; the example invocations match the real command syntax. This is the only sign-off a human must give for `skill-docs-project-guidance`.

## Watch closely

- [ ] **`work-on-task` strips `project` before session registration.** The `capture-and-bind-with-project-flag` log notes `project` had to be destructured out of `parsedWorkOnTask` before spreading `...registerInput` into `store.registerSession`, since it is not a session field and would otherwise leak in. Confirm the registered session has no stray `project` field.
- [ ] **`recall-candidates` parses `--project` from `args` directly** (no positional args), unlike the other commands. The `recall-with-project-flag` slice added `parseRecallCandidatesArgs`, which throws the usage string on a missing flag value and `Unknown option` on anything else — worth a glance that malformed flags fail cleanly.
- [ ] **`create-with-project-flag` integration test uses `runTraceCli` directly, not `execFileSync`.** The slice referenced "the execFileSync pattern from the task CRUD tests," but the agent deviated to call the exported `runTraceCli(argv, env, cwd)` under vitest (the only existing `execFileSync` test runs the built bundle and triggers a full `pnpm build` — too heavy). This is faithful but means the bundle path itself is only exercised by the human items above.
- [ ] **Original `create-with-project-flag` gate ran on the host, not in-iteration.** That iteration's Bash sandbox was broken (stale `/private/tmp` dir, wrong uid); the orchestrator re-ran the full gate on the host afterwards (105 + 3 passed, types/lint clean) and flipped the slice to `done`. The SRT `/tmp` vs `/private/tmp` policy was fixed for later iterations — no action needed, noted for context.
