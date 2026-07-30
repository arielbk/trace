# Changelog

Notable changes to `@arielbk/trace`. Older releases are documented in the
[GitHub releases](https://github.com/arielbk/trace/releases).

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
