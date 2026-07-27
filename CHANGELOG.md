# Changelog

Notable changes to `@arielbk/trace`. Older releases are documented in the
[GitHub releases](https://github.com/arielbk/trace/releases).

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
