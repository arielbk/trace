# Changelog

Notable changes to `@arielbk/trace`. Older releases are documented in the
[GitHub releases](https://github.com/arielbk/trace-v2/releases).

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
