# Tasks: codex-reentry

Vertical slices for making Trace usable from Codex. Each slice is red->green->refactor and keeps the existing Claude Code path intact.

## Slices

### `codex-plugin-scaffold` — Ship Codex plugin + skill skeleton

**Status:** done

**Outside-in:** The repo contains a Codex plugin manifest, Codex marketplace metadata, and a Codex-specific `trace` skill that can be discovered independently of the Claude Code plugin. The skill must not reference Claude-only environment variables.

**Feedback loop:** Scaffold tests assert `.codex-plugin/plugin.json`, Codex marketplace metadata, and Codex skill frontmatter/prose exist and carry the expected Codex-specific commands.

**Human checkpoint:** no

**Depends on:** none

---

### `codex-init-installer` — Install local Codex skill idempotently

**Status:** done

**Outside-in:** `trace init` installs or refreshes a local Codex skill under `$HOME/.agents/skills/trace/SKILL.md`, renders an absolute bundled CLI path into the installed skill, and reports the installed path. Running it twice is stable and does not modify Claude settings.

**Feedback loop:** Installer tests use temp `HOME` directories to prove the install path, content, output, and idempotency.

**Human checkpoint:** no

**Depends on:** codex-plugin-scaffold

---

### `codex-skill-flow` — Codex bind and re-entry workflow

**Status:** done

**Outside-in:** In a Codex session, the skill backfills Codex transcripts with `trace session scan --codex`, then uses existing `skill work-on-task` and `skill re-enter` verbs to bind the current Codex thread and print re-entry manifests.

**Feedback loop:** CLI tests with a synthetic Codex home and `CODEX_THREAD_ID` prove scan, bind, `taskDocsDir`, and re-entry output work together through public commands.

**Human checkpoint:** no

**Depends on:** codex-init-installer

---

### `cross-tool-reentry` — Prove Claude -> Codex and smoke Codex -> Claude

**Status:** done

**Outside-in:** A task seeded from a Claude session and docs can be re-entered from Codex with Claude docs and session pointers intact. Codex-created work can also be read by Claude through the existing manifest path when no new core behavior is required.

**Feedback loop:** Tests seed both directions using public CLI commands and assert the manifest surfaces the prior tool's docs/session metadata.

**Human checkpoint:** no

**Depends on:** codex-skill-flow

---

### `codex-docs-and-qa` — Update docs, run verification, and write QA

**Status:** done

**Outside-in:** README and the Codex re-entry docs describe Codex plugin/local skill setup, backfill capture, and the supported cross-tool direction without claiming a live Codex hook.

**Feedback loop:** Run targeted suites, typechecks, bundle checks if needed, and write `codex-reentry.qa.md` with verified and human-check items.

**Human checkpoint:** no

**Depends on:** cross-tool-reentry

## DAG

```text
codex-plugin-scaffold
  -> codex-init-installer
  -> codex-skill-flow
  -> cross-tool-reentry
  -> codex-docs-and-qa
```
