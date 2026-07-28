import { existsSync } from "node:fs";
import { join } from "node:path";
import { TOOL_NAMES, type TargetRecord, type ToolName } from "./integration-registry.ts";
import type { Env } from "./seam.ts";

/**
 * How a candidate root was discovered. `default` is the conventional root for
 * the tool; `environment` is an active override such as `CLAUDE_CONFIG_DIR`.
 */
export type DetectionProvenance =
  | { kind: "default" }
  | { kind: "environment"; variable: string };

/**
 * A presentation-neutral Integration Target candidate. Its identity is the
 * existing `(tool, root)` pair; `detection` and `registered` carry the
 * provenance a picker turns into a display hint. At least one of the two is
 * always present — a candidate exists because it was detected, registered, or
 * both.
 */
export type TargetCandidate = {
  tool: ToolName;
  root: string;
  /** Set when host detection resolved this root for its tool. */
  detection?: DetectionProvenance;
  /** Set when this root is already an Integration Registry target. */
  registered?: TargetRecord;
};

/** Tool order used everywhere candidates are grouped or listed. */
export const CANDIDATE_TOOL_ORDER: readonly ToolName[] = TOOL_NAMES;

/** Human-readable host names, used for plan lines and picker group headings. */
export const TOOL_LABELS: Record<ToolName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "GitHub Copilot CLI",
};

function homeDir(env: Env, tool: ToolName): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    throw new Error(
      `HOME/USERPROFILE must be set to resolve the ${tool} config root`,
    );
  }
  return home;
}

/**
 * Resolves the Claude config root for ordinary setup: an explicit
 * `CLAUDE_CONFIG_DIR` wins over the default `~/.claude` root. Callers layer an
 * explicit `--target` on top of this (explicit target > env > default).
 */
export function resolveClaudeConfigRoot(env: Env): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return join(homeDir(env, "claude"), ".claude");
}

/**
 * Resolves the Codex config root: `CODEX_HOME` wins over the default
 * `~/.codex`. Callers may layer an explicit `--target` on top.
 */
export function resolveCodexConfigRoot(env: Env): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  return join(homeDir(env, "codex"), ".codex");
}

/** Resolves the Cursor config root (`~/.cursor`). */
export function resolveCursorConfigRoot(env: Env): string {
  return join(homeDir(env, "cursor"), ".cursor");
}

/**
 * Resolves the Copilot config root: `COPILOT_HOME` wins over the default
 * `~/.copilot`. This is the same root the transcript adapter and the session
 * locator read, so setup and capture always agree on which Copilot they mean.
 */
export function resolveCopilotConfigRoot(env: Env): string {
  if (env.COPILOT_HOME) return env.COPILOT_HOME;
  return join(homeDir(env, "copilot"), ".copilot");
}

type Detector = {
  resolveRoot: (env: Env) => string;
  /** The environment variable that overrides the conventional root, if any. */
  override?: string;
};

const DETECTORS: Record<ToolName, Detector> = {
  claude: { resolveRoot: resolveClaudeConfigRoot, override: "CLAUDE_CONFIG_DIR" },
  codex: { resolveRoot: resolveCodexConfigRoot, override: "CODEX_HOME" },
  cursor: { resolveRoot: resolveCursorConfigRoot },
  copilot: { resolveRoot: resolveCopilotConfigRoot, override: "COPILOT_HOME" },
};

/**
 * Resolves the active root for `tool` and reports it only when the directory
 * exists, preserving the host-detection rule that Trace never invents a root
 * for a tool the user has not installed.
 */
function detect(
  tool: ToolName,
  env: Env,
): { root: string; detection: DetectionProvenance } | undefined {
  const detector = DETECTORS[tool];
  let root: string;
  try {
    root = detector.resolveRoot(env);
  } catch {
    return undefined;
  }
  if (!existsSync(root)) return undefined;
  const { override } = detector;
  return {
    root,
    detection:
      override && env[override]
        ? { kind: "environment", variable: override }
        : { kind: "default" },
  };
}

/**
 * The complete set of Integration Targets bare `trace setup` knows about: every
 * detected active/default root plus every registered target, deduplicated by
 * `(tool, root)`. A root that is both detected and registered appears once,
 * carrying both pieces of provenance.
 *
 * Order is deterministic — tools in {@link CANDIDATE_TOOL_ORDER}, and within a
 * tool the detected root first, then registered roots in registry order.
 */
export function discoverTargetCandidates(
  env: Env,
  registeredTargets: readonly TargetRecord[],
): TargetCandidate[] {
  const candidates: TargetCandidate[] = [];

  for (const tool of CANDIDATE_TOOL_ORDER) {
    const registered = registeredTargets.filter((target) => target.tool === tool);
    const byRoot = new Map<string, TargetCandidate>();

    const detected = detect(tool, env);
    if (detected) {
      byRoot.set(detected.root, {
        tool,
        root: detected.root,
        detection: detected.detection,
      });
    }
    for (const target of registered) {
      const existing = byRoot.get(target.root);
      if (existing) {
        existing.registered = target;
      } else {
        byRoot.set(target.root, { tool, root: target.root, registered: target });
      }
    }

    candidates.push(...byRoot.values());
  }

  return candidates;
}
