# Changelog

Notable changes to `@arielbk/trace`. Older releases are documented in the
[GitHub releases](https://github.com/arielbk/trace/releases).

## 0.20.0

Trace task state is now concise, attributable, and progressively disclosed when
you re-enter work. The release also completes the move away from the retired
plugin-install channel: the CLI owns the canonical skills and managed setup.

### Highlights

- **State has one compact shape.** Living state documents keep a one-line
  summary, a short current position, and one next action or unresolved question
  instead of accumulating empty or repetitive sections.
- **Re-entry starts with the useful context.** Manifests now surface the task's
  state first, index supporting docs rather than dumping them, identify the
  latest prior session, and report the branch and linked-worktree context where
  the task was last worked on.
- **State provenance is visible.** Trace records which session authored task
  prose, and the task page explains whether displayed state came from that prose
  or was inferred from activity.

### Reliability

- State freshness is owned by a single document model and sync preserves the
  metadata needed to make the same freshness decision on another machine.
- Git context is sampled when state is checked, so branching after a task bind
  no longer leaves re-entry pointing at the branch the session originally
  arrived on.
- Canonical skills now ship from the top-level `skills/` tree; legacy plugin
  marketplace manifests and hooks have been removed.

## 0.19.0

`trace update` is now a one-step operation in a terminal, and no longer trips a
Node deprecation warning on Windows.

### Highlights

- **Bare `trace update` asks instead of exiting.** Upgrading used to take two
  commands: the first printed a plan and told you to re-run it with `--yes`.
  Run interactively, it now shows the plan and asks `Update to vY?` with Yes
  preselected, applying on confirmation. Declining — or Ctrl-C — prints
  `Update cancelled; no changes made.` and exits 0.

### Fixes

- **Windows updates no longer emit DEP0190.** The update spawn passed an args
  array alongside `shell: true` on win32, the exact combination Node
  deprecated. Args are now folded into a single pre-quoted command string.
  The shell stays on Windows deliberately — Node refuses to spawn `.cmd`/`.bat`
  directly (CVE-2024-27980), and both the package managers and the recorded CLI
  path are batch shims there. POSIX is untouched.

### Chores

- The prompt seam is split, so a command needing only a yes/no question
  receives a narrow `ConfirmPrompt` rather than the full setup prompt.
- Non-interactive `trace update` output is now pinned by whole-result
  assertions lifted from the 0.18.2 release, covering the preview, `--yes`
  apply, already-current, and reconcile-failure paths.

## 0.18.2

Fixes to the sign-in and first-sync flow, found by walking the whole flow on a
second machine.

### Fixes

- **A login you walked away from is recoverable.** The board can now ask the
  serving process whether this machine has a login in progress and pick it back
  up. Previously the only copy of the attempt lived in the account popover's
  component state, so closing the popover at the key prompt — or reloading the
  page — stranded an approved token with no way to finish it, offering nothing
  but "start over".
- **Signing in starts a sync immediately** instead of leaving a freshly
  signed-in machine idle for up to five minutes waiting out the periodic
  interval.
- **Accepting a document key confirms itself** with a brief "Documents
  unlocked" beat, where before a correct key produced no acknowledgement.
- **The avatar's sync badge is quiet when everything is fine.** It used to
  render a dot for the *succeeded* state, so it was lit almost always and
  carried no signal when it mattered. Its in-flight spinner now rotates cleanly
  in the accent colour instead of wobbling on the text baseline.
- **Pulled documents keep the source machine's timestamps.** A task pulled to a
  second machine reported "last active" as the moment of the pull, so it could
  claim activity that never happened. Documents carrying a title or description
  were affected even where the file mtime was already correct.

### Chores

- Dependency updates across the workspace, including React Router 8, jsdom 30,
  `@testing-library/jest-dom` 7, and globals 17, plus a pinned esbuild under
  tsup. Clears 11 dev-only advisories reported by `pnpm audit`.

## 0.18.0

Trace now supports GitHub Copilot CLI as a first-class session host alongside
Claude Code, Codex, and Cursor.

### Highlights

- **Copilot sessions appear on the board.** Trace discovers live Copilot
  sessions from their lock files, reads `events.jsonl` transcripts, records
  model and message summaries, and reports the output-token totals exposed by
  Copilot.
- **Setup manages the complete Copilot integration.** `trace setup` installs
  the Trace skill and Copilot lifecycle hooks, and setup, update, removal, and
  stale-integration warnings treat Copilot like the other supported hosts.
- **Copilot task workflows use the shared Trace protocol.** Session start and
  stop hooks bind work to tasks, check task state freshness, and preserve the
  same re-entry and document-placement behavior used by the existing agents.
- **Future integration records remain forward-compatible.** Registry reads and
  mutations preserve structurally valid targets introduced by newer Trace
  versions while exposing all four hosts supported by this release.

## 0.17.1

### Fixes

- **Setup no longer fails on targets registered by a newer CLI.** The
  Integration Registry now validates and preserves structurally valid records
  for unsupported tool names while exposing only `claude`, `codex`, and
  `cursor` to the current setup/removal code. Older CLIs can reconcile the
  integrations they understand without deleting future-tool metadata or
  declaring the complete registry corrupt.

## 0.17.0

Trace Cloud Sync is now manageable from the board, with browser-based sign-in,
clear sync status, and a machine-local automatic-sync policy. The CLI also gains
standard version output and human-oriented terminal help.

### Highlights

- **Sign in and out from the board.** The account menu now supports GitHub and
  Google device-flow login without leaving the board. New accounts receive their
  document key once; existing accounts can validate or deliberately replace a
  missing local key before credentials are stored.
- **Sync status has one consistent home.** A shared account control appears on
  task-list and task-detail pages and reports whether Cloud Sync is configured,
  whether automatic sync is enabled, the latest run state, last success, and
  failure details.
- **Automatic sync can be disabled without disabling Cloud Sync.**
  `trace config set auto-sync false` suppresses implicit sync triggers while
  keeping explicit `trace sync` available. Unsetting the key restores the
  default-on policy.

### CLI improvements

- **Version discovery is standard.** `trace --version`, `trace -v`, and
  `trace version` report the installed CLI version.
- **Terminal help is designed for humans.** Bare `trace` and `trace --help`
  show an indented, workflow-oriented view with subtle TTY-only color. Piped
  output remains exhaustive and plain, and `NO_COLOR`/`TERM=dumb` are honored.
- **Older CLIs can update through newer registries.** `trace update` reads only
  the stable registry envelope needed to upgrade, so a target type introduced
  by a newer CLI cannot block the update path. Setup and registry mutations
  retain strict validation.

### Reliability

- **The complete Cloud Sync flow is covered end to end.** Acceptance tests prove
  every implicit trigger reaches the transport under the default policy, manual
  mode stays silent until `trace sync`, and a task can move between two machine
  stores through push and pull.
- **Browser and terminal authentication share one service.** GitHub and Google
  browser login, existing-key validation, replacement-key confirmation, logout,
  and the terminal `login`/`logout`/`whoami` commands now exercise the same
  underlying authentication flow.

## 0.16.0

Trace now ships as one globally installed CLI that owns its agent integrations.
The npm package contains the board and the canonical skills, so installation,
setup, and updates all follow one managed path.

### Highlights

- **One CLI-first install for every supported agent.** Install
  `@arielbk/trace` globally, then run `trace setup` to wire Trace into Claude
  Code, Codex, and Cursor. The published tarball now includes the README and all
  six canonical skills alongside the CLI and board.
- **Interactive setup discovers every target.** Bare `trace setup` inventories
  installed and previously registered agent roots, presents a preselected
  checklist grouped by tool, previews the exact plan, and confirms before
  writing. Explicit `--tool`, `--target`, and `--yes` paths remain deterministic
  for scripts and custom configurations.
- **Managed updates keep integrations aligned.** `trace update` reinstalls the
  latest package with the detected package manager and reconciles every
  registered target. The CLI also warns when installed integrations are stale.
- **Migration and removal are guarded.** Setup detects legacy plugin entries,
  pinned hooks, collisions, unsupported paths, and ambiguous selections without
  blocking healthy targets. Writes are atomic, and `trace setup --remove`
  removes only Trace-owned artifacts and metadata.

### Improvements

- **Setup feedback is clearer.** Target labels, skipped-target summaries,
  per-target remediation, and non-interactive behavior now make it explicit
  which integrations will change and which need attention.
- **The integration lifecycle is covered end to end.** New distribution,
  inventory, prompt, guardrail, reconciliation, removal, update, and packed
  tarball smoke tests exercise the same artifacts users install.

## 0.15.1

Sync-fidelity fixes for cloud sync between machines. All three are
client-side; task rows round-trip through the sync server unchanged, so no
server changes are involved.

### Fixes

- **Pulled docs keep their real modified times.** Doc manifest entries now
  carry the source machine's file mtime (end-to-end encrypted alongside the
  file content), and pulling restores it — so the board's "document last
  modified" and task ordering reflect when a doc was actually edited, not
  when it was synced. Manifests from older clients still apply cleanly.
- **Pins propagate between machines.** Pinning or unpinning a task now bumps
  the row's last-write-wins clock and rides the sync payload, so a pin made
  on one machine shows up on the other. Rows from older clients merge as
  unpinned.
- **Pulled tasks join existing projects by git identity.** Task rows now
  carry their project's git fingerprint (remote URL and root commit), and
  merging resolves projects by fingerprint before falling back to path
  matching — a task pushed from `~/a/repo` on one machine lands under the
  existing project for the same repo cloned at `~/b/repo` on another,
  instead of minting a duplicate project.
- **Plugin skills and hooks correctly pin the published CLI again.** The
  0.14.0 release accidentally shipped skill/hook templates pointing at a
  local development build path instead of `npx @arielbk/trace@<version>`;
  the pins are restored and stamped to 0.15.1.

### Improvements

- **The board syncs more eagerly, shrinking the divergence window.** While
  `trace serve` is running, the board now syncs shortly after board
  mutations (pin, archive, checkbox…), on mount and window focus, and on a
  periodic timer while left open — so acting on a freshly-focused board
  starts from up-to-date rows instead of waiting for the next manual sync.
  Triggers no-op when logged out and are throttled server-side.
