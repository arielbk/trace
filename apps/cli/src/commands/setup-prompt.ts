import {
  CANDIDATE_TOOL_ORDER,
  TOOL_LABELS,
  type TargetCandidate,
} from "./setup-candidates.ts";
import type { ToolName } from "./integration-registry.ts";
import type { Env } from "./seam.ts";

/**
 * The answer to one prompt. `cancelled` is a user-directed escape (Clack's
 * cancel symbol, normalised here) rather than an error, so the orchestrator
 * never has to know about Clack's sentinel value.
 */
export type PromptResult<T> = { cancelled: true } | { cancelled: false; value: T };

/** One selectable Integration Target inside the picker. */
export type TargetOption = {
  /** The `(tool, root)` identity, opaque to the renderer. */
  value: string;
  /** The config root, shortened for display. */
  label: string;
  /** Discovery and registry provenance, e.g. `detected · default`. */
  hint: string;
};

/** One tool's section of the picker. */
export type TargetOptionGroup = { label: string; options: TargetOption[] };

/** The complete model rendered by a target picker. */
export type TargetSelectionRequest = {
  message: string;
  groups: TargetOptionGroup[];
  /** Identities checked when the picker opens — every known candidate. */
  initialValues: string[];
};

/**
 * The injectable seam between setup orchestration and Clack. Everything the
 * interactive flow needs from a terminal lives here, so orchestration can be
 * driven by a fake in tests without rendering a real UI.
 */
export type SetupPrompt = {
  selectTargets(request: TargetSelectionRequest): Promise<PromptResult<string[]>>;
  confirmInstall(request: { message: string }): Promise<PromptResult<boolean>>;
  note(message: string, title: string): void;
  /** Renders an attention-grabbing terminal warning without changing exit status. */
  warn(message: string): void;
};

/**
 * The stable, renderer-opaque identity of an Integration Target. Uses a NUL
 * separator so no config root can collide with the encoding.
 */
export function targetIdentity(tool: ToolName, root: string): string {
  return `${tool}\0${root}`;
}

/** Shortens a config root under the user's home directory to `~/…`. */
function displayRoot(root: string, env: Env): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home) return root;
  if (root === home) return "~";
  for (const separator of ["/", "\\"]) {
    if (root.startsWith(`${home}${separator}`)) {
      return `~${root.slice(home.length)}`;
    }
  }
  return root;
}

/**
 * Renders a candidate's provenance as a hint: how it was discovered, and
 * whether the Integration Registry already knows it (and at which version).
 * Deliberately built from data Trace already holds — the picker never inspects
 * installed artifacts or computes reconciliation status.
 */
function candidateHint(candidate: TargetCandidate): string {
  const parts: string[] = [];
  if (candidate.detection) {
    parts.push(
      "detected",
      candidate.detection.kind === "environment"
        ? candidate.detection.variable
        : "default",
    );
  }
  parts.push(
    candidate.registered
      ? `registered · v${candidate.registered.version}`
      : "not registered",
  );
  return parts.join(" · ");
}

/**
 * Builds the picker model for a discovered candidate set: one group per tool in
 * {@link CANDIDATE_TOOL_ORDER}, candidates in discovery order within a group,
 * and every candidate initially selected so accepting the default preserves the
 * setup-everything behavior.
 */
export function buildTargetSelection(
  candidates: readonly TargetCandidate[],
  env: Env,
): TargetSelectionRequest {
  const groups: TargetOptionGroup[] = [];
  for (const tool of CANDIDATE_TOOL_ORDER) {
    const options = candidates
      .filter((candidate) => candidate.tool === tool)
      .map((candidate) => ({
        value: targetIdentity(candidate.tool, candidate.root),
        label: displayRoot(candidate.root, env),
        hint: candidateHint(candidate),
      }));
    if (options.length > 0) groups.push({ label: TOOL_LABELS[tool], options });
  }

  return {
    message: "Select the targets to set up",
    groups,
    initialValues: groups.flatMap(({ options }) =>
      options.map(({ value }) => value),
    ),
  };
}
