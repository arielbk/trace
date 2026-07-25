import { IntegrationRegistry } from "./integration-registry.ts";
import {
  discoverTargetCandidates,
  type TargetCandidate,
} from "./setup-candidates.ts";
import {
  EMPTY_INVENTORY,
  reconcileSelectedTargets,
} from "./setup-operations.ts";
import {
  buildTargetSelection,
  targetIdentity,
  type SetupPrompt,
} from "./setup-prompt.ts";
import { failure, success, type CommandResult, type Env } from "./seam.ts";

const CANCELLED = "Setup cancelled; no changes made.\n";

/**
 * The interactive half of `trace setup`: show every known Integration Target in
 * one picker, review the submitted selection's plan, and reconcile it after an
 * explicit confirmation. The synchronous setup operation remains the
 * deterministic path for flags and non-interactive callers.
 */
export async function interactiveSetupOperation(
  ctx: { env: Env; cwd: string; stdin: string },
  prompt: SetupPrompt,
): Promise<CommandResult> {
  let registry: IntegrationRegistry;
  let candidates: TargetCandidate[];
  try {
    registry = IntegrationRegistry.fromEnv(ctx.env);
    candidates = discoverTargetCandidates(ctx.env, registry.targets());
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  // An empty picker cannot be answered, so the deterministic path's failure
  // stands in for it.
  if (candidates.length === 0) return failure(EMPTY_INVENTORY);

  const selection = await prompt.selectTargets(
    buildTargetSelection(candidates, ctx.env),
  );
  if (selection.cancelled) return success(CANCELLED);

  const submitted = new Set(selection.value);
  const selected = candidates.filter((candidate) =>
    submitted.has(targetIdentity(candidate.tool, candidate.root)),
  );
  if (selected.length === 0) return success("No targets selected.\n");

  // The terminal reviews the plan itself, so it needs neither a "re-run with
  // --yes" footer nor the plan repeated in the closing summary.
  const format = { previewFooter: "", planInSummary: false };

  // Preview and apply are handed the identical selection, so confirmation can
  // never approve one set of targets and write another.
  const preview = reconcileSelectedTargets(selected, {
    apply: false,
    env: ctx.env,
    registry,
    format,
  });
  if (preview.exitCode !== 0) return preview;
  prompt.note(preview.stdout.trimEnd(), "Setup plan");

  const confirmed = await prompt.confirmInstall({
    message: "Install Trace into these targets?",
  });
  if (confirmed.cancelled || !confirmed.value) return success(CANCELLED);

  return reconcileSelectedTargets(selected, {
    apply: true,
    env: ctx.env,
    registry,
    format,
  });
}
