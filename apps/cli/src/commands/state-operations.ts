import {
  computeStateFreshness,
  inferSessionIdentity,
  partitionStateDocument,
  resolveTaskDocsDir,
  stampStateDocumentProse,
  type StateFreshness,
} from "@trace/core";
import { recordSessionWorkContext } from "./bind.ts";
import {
  buildManifestEntries,
  renderTaskDocManifest,
} from "./task-operations.ts";
import {
  failure,
  isHelpFlag,
  success,
  withStore,
  type CommandResult,
  type Env,
  type Store,
} from "./seam.ts";

export type CommandContext = { env: Env; cwd: string; stdin: string };

// `eqnx state check` and the re-entry manifest share one freshness verdict,
// owned by `computeStateFreshness` in core. Re-exported here so CLI callers keep
// importing it from the module that uses it.
export type { StateFreshness };

// Freshness for a task, resolved from the store's registered docs. Reads only.
export function computeTaskStateFreshness(
  store: Store,
  databasePath: string,
  task: { id: string; slug: string },
): StateFreshness {
  return computeStateFreshness(
    resolveTaskDocsDir(databasePath, task.slug),
    store.listDocsForTask(task.id),
  );
}

// `eqnx state check <task>` — reconcile the docs-manifest footer of the task's
// state.md and report a neutral JSON verdict. The footer is rendered (creating
// state.md from a scaffold) only when the task has at least one non-state doc;
// the reconcile is write-if-changed, so a repeat run is a byte-identical no-op.
//
// The verdict also reports the docs `fingerprint`, and — only when the current
// session is explicitly bound to this task — a prose-pass directive
// (`needsProsePass`, `mode`, `reason`, `changedDocs`). Without an explicit
// binding the prose-pass fields are omitted (the session abstains), so an
// unbound chat turn is never asked to reflect.
export function stateCheckOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0])) return success("Usage: eqnx state check <task>\n");
  const ref = rawArgs[0];
  if (!ref) return failure("Task id is required");

  return withStore(ctx.env, (store, databasePath) => {
    const task = store.getTaskByRef(ref);
    if (!task) return failure(`Task not found: ${ref}`, 1);

    // Only materialize state.md once a non-state doc exists — an empty task
    // should not sprout a bare manifest.
    const { others } = partitionStateDocument(store.listDocsForTask(task.id));
    if (others.length > 0) {
      renderTaskDocManifest(store, databasePath, task);
    }

    // The per-turn touchpoint with a live cwd and a bound session, so this is
    // where a session that branched after binding gets its Git work context
    // re-sampled. Same strict-binding gate as the prose directive below: an
    // unbound turn must never relabel where someone else's task was worked on.
    const boundSessionId = liveSessionBoundTo(store, ctx.env, task.id);
    if (boundSessionId) {
      recordSessionWorkContext(store, boundSessionId, ctx.cwd);
    }

    const freshness = computeTaskStateFreshness(store, databasePath, task);

    const verdict: StateFreshness & { reason?: string } = {
      stateExists: freshness.stateExists,
      statePath: freshness.statePath,
      fingerprint: freshness.fingerprint,
    };

    // Prose-pass directive is gated on an explicit binding of the current
    // session to this task — never the most-recent-task fallback. An unbound
    // session abstains: the prose fields are omitted entirely.
    if (freshness.needsProsePass !== undefined && boundSessionId) {
      verdict.needsProsePass = freshness.needsProsePass;
      if (freshness.needsProsePass) {
        verdict.mode = freshness.mode;
        verdict.changedDocs = freshness.changedDocs;
        verdict.reason = proseDriftReason(
          freshness.mode as "seed" | "refresh",
          task.slug,
        );
      }
    }

    return success(`${JSON.stringify(verdict)}\n`);
  });
}

// The prose-pass directive shared by the Stop hook (via `check`) and the
// re-entry manifest: name the skill that owns the template, and the reflect
// command that advances the marker. Seed is imperative — it fires once per
// task and an unwritten state file always warrants a pass. Refresh is
// advisory: any doc append re-drifts the fingerprint (a loop writing a log
// drifts on every turn), so the agent judges whether a pass is worth it.
export function proseDriftReason(
  mode: "seed" | "refresh",
  slug: string,
): string {
  return mode === "seed"
    ? `state.md has no prose yet — invoke the \`trace-state\` skill to write the living-state prose (it stamps via \`eqnx state reflect ${slug}\` when done).`
    : `state.md prose may be stale — the docs changed since it was last written. Use your judgment: if the changes carry meaningful new context (not just routine appends like logs), invoke the \`trace-state\` skill to refresh it (it stamps via \`eqnx state reflect ${slug}\` when done); otherwise no refresh is needed.`;
}

// `eqnx state reflect <task>` — recompute the current docs fingerprint and
// stamp it into state.md's machine-owned prose marker, preserving the prose
// above the docs-manifest fence and the fence itself. Run by a human (or hook)
// after the living-state prose has been written/updated, so a subsequent
// `eqnx state check` sees the prose as reconciled with the current docs.
export function stateReflectOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0]))
    return success("Usage: eqnx state reflect <task>\n");
  const ref = rawArgs[0];
  if (!ref) return failure("Task id is required");

  return withStore(ctx.env, (store, databasePath) => {
    const task = store.getTaskByRef(ref);
    if (!task) return failure(`Task not found: ${ref}`, 1);

    const docsDir = resolveTaskDocsDir(databasePath, task.slug);
    const freshness = computeTaskStateFreshness(store, databasePath, task);

    // With no non-state doc there is nothing to reflect on; mirror `check` and
    // leave state.md untouched (it should not exist yet).
    if (freshness.needsProsePass === undefined) {
      return success(
        `${JSON.stringify({
          stateExists: freshness.stateExists,
          statePath: freshness.statePath,
          fingerprint: freshness.fingerprint,
        })}\n`,
      );
    }

    // This is the one seam that means "the prose was just written", so it is
    // the only place allowed to record when that happened.
    stampStateDocumentProse(
      docsDir,
      task.title,
      buildManifestEntries(store, databasePath, task),
      { fingerprint: freshness.fingerprint, writtenAt: new Date().toISOString() },
    );

    return success(
      `${JSON.stringify({
        stateExists: true,
        statePath: freshness.statePath,
        fingerprint: freshness.fingerprint,
      })}\n`,
    );
  });
}

// The live session (resolved from env) when it exists and is explicitly bound
// to `taskId`, else null. Mirrors the strict-binding contract: an unbound
// session, or one bound to a different task, does not qualify.
function liveSessionBoundTo(
  store: Store,
  env: Env,
  taskId: string,
): string | null {
  const { id } = inferSessionIdentity(env);
  if (!id) return null;
  return store.getSession(id)?.taskId === taskId ? id : null;
}
