# Project override flag

Add a `--project <dir>` flag to every project-resolving trace CLI command (defaulting to cwd, hard-erroring on nonexistent paths) and teach the trace/recall skills to use it, so tasks created or recalled from a multi-project sandbox directory key to the real project root.

## Slices

### `create-with-project-flag` — Resolution helper + `--project` on task create

**Status:** done

**Outside-in:** `trace task create "Title" --project <dir>` stores `<dir>`'s git root as `project_root`; omitting the flag behaves exactly as today; a nonexistent dir exits non-zero with a message naming the bad path. Relative dirs resolve against cwd.

**Feedback loop:** Core unit tests for the resolution helper (flag absent → cwd; relative path resolves against cwd; nonexistent path throws; git-less existing dir returns the dir itself). CLI integration test (`execFileSync` pattern from the task CRUD tests): create from an unrelated cwd with `--project` pointing at another repo → stored `project_root` is that repo's root; nonexistent `--project` exits non-zero.

**Human checkpoint:** no

**Depends on:** none

### `capture-and-bind-with-project-flag` — `--project` on task capture and work-on-task

**Status:** done

**Outside-in:** `trace task capture ... --project <dir>` and `trace skill work-on-task "Title" --project <dir>` key the task to `<dir>`'s git root instead of cwd's.

**Feedback loop:** CLI integration tests: capture and work-on-task invoked from an unrelated cwd with `--project` store the target repo's root as `project_root`; omitting the flag preserves today's behavior; nonexistent path exits non-zero.

**Human checkpoint:** no

**Depends on:** create-with-project-flag

### `recall-with-project-flag` — `--project` on recall-candidates

**Status:** done

**Outside-in:** `trace skill recall-candidates --project <dir>` scopes the candidate pool to `<dir>`'s git root instead of cwd's.

**Feedback loop:** CLI integration test: a task keyed to another repo's root is returned by `recall-candidates --project <that repo>` run from an unrelated cwd, and is absent from a plain `recall-candidates` run from that same cwd.

**Human checkpoint:** no

**Depends on:** create-with-project-flag

### `skill-docs-project-guidance` — Skill docs teach the agent to pass --project

**Status:** needs-review

**Outside-in:** `skills/trace/SKILL.md` and `skills/recall/SKILL.md` instruct the agent: default to cwd; when the work clearly lives in a different project than the CLI's working directory, pass `--project <dir of that project>`. Example invocations show the flag.

**Feedback loop:** Manual: copy-paste each documented invocation against a scratch repo and confirm it runs and keys to the right project root. Human review of the wording, since this is the agent-facing contract.

**Human checkpoint:** yes

**Depends on:** capture-and-bind-with-project-flag, recall-with-project-flag
