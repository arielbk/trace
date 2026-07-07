# Skill-routing eval

A report — **not** a test — that drives real user utterances through `claude -p`
and asserts which skill the agent routed to. It's deliberately off the test/CI
path: it's non-deterministic and **costs API quota on every run** (one `claude -p`
call per corpus case). Read it as a report; don't gate CI on it.

The corpus lives in [`corpus.ts`](./corpus.ts). Some cases are designed to
*fail* — the steal-boundary / under-trigger cases surface where routing is
fragile, so a non-zero failure count is expected, not a bug. The header comment
in `corpus.ts` flags which.

## Prerequisite: a clean, logged-in sandbox config dir

The eval shells out to `claude -p` against a **separate** Claude config dir, so
your real `~/.claude` never bleeds into the run. You point at it with
`CLAUDE_CONFIG_DIR`. The documented default is `~/.claude-sandbox`.

Two invariants the harness enforces (it fast-fails otherwise, see
`resolveConfigDir()` in [`src/invoker.ts`](./src/invoker.ts)):

1. **The dir exists and is logged in** — it must contain a `.claude.json`.
2. **No trace plugin is installed or enabled in it.** The eval must route
   against the fixture's *project* skills under
   [`fixture/.claude/skills/`](./fixture/.claude/skills), not an installed
   copy of the plugin. If the plugin is also present, its (possibly stale)
   skills get exercised instead and routing is scored against the wrong source.

### One-time setup

```sh
# 1. Create the sandbox dir and log in once (opens the normal auth flow).
mkdir -p ~/.claude-sandbox
CLAUDE_CONFIG_DIR=~/.claude-sandbox claude   # log in, then exit

# 2. Make sure the trace plugin is NOT installed in the sandbox. If you ever
#    installed it there, remove it:
CLAUDE_CONFIG_DIR=~/.claude-sandbox claude plugin uninstall trace@trace
CLAUDE_CONFIG_DIR=~/.claude-sandbox claude plugin marketplace remove trace
```

If the sandbox is polluted, the eval aborts before spending any quota with a
message naming the offending plugin and the exact commands above.

## Running

```sh
# Full corpus on the default cheap model (Haiku):
CLAUDE_CONFIG_DIR=~/.claude-sandbox pnpm eval

# Probe a regression on a stronger model:
CLAUDE_CONFIG_DIR=~/.claude-sandbox EVAL_MODEL=sonnet pnpm eval

# Run only cases whose utterance/note matches a keyword (cheap, focused):
CLAUDE_CONFIG_DIR=~/.claude-sandbox node evals/run-subset.ts steal under
```

The report **streams**: the header prints up front, then one row per case as it
completes. Each row is a real billed call, so if you see routing going wrong you
can `Ctrl-C` early instead of paying for the whole corpus. A summary
(`N/M passed`) prints at the end; the process exits non-zero if any case failed.

`EVAL_MODEL` defaults to `haiku` — routing is a cheap classification task, so the
report stays fast and inexpensive. Override it only to chase a model-specific
regression.

## Unit tests (free, on CI)

The harness's own logic — the stream parser, the verdict normalizer, the
reporter, the config-dir guard — is covered by fast deterministic tests that
never call `claude`:

```sh
pnpm test:evals
```
