import {
  computeDocsFingerprint,
  hasProseBody,
  inferSessionIdentity,
  readProseFingerprint,
  resolveTaskDocsDir,
  type DocFingerprintInput,
} from "@trace/core";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { renderTaskDocManifest } from "./task-operations.ts";
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

// `trace state check <task>` — reconcile the docs-manifest footer of the task's
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
  if (isHelpFlag(rawArgs[0])) return success("Usage: trace state check <task>\n");
  const ref = rawArgs[0];
  if (!ref) return failure("Task id is required");

  return withStore(ctx.env, (store, databasePath) => {
    const task = store.getTaskByRef(ref);
    if (!task) return failure(`Task not found: ${ref}`, 1);

    const docsDir = resolveTaskDocsDir(databasePath, task.slug);
    const statePath = join(docsDir, "state.md");

    const nonStateDocs = store
      .listDocsForTask(task.id)
      .filter((doc) => basename(doc.path) !== "state.md");

    // Only materialize state.md once a non-state doc exists — an empty task
    // should not sprout a bare manifest.
    if (nonStateDocs.length > 0) {
      renderTaskDocManifest(store, databasePath, task);
    }

    const fingerprintInputs: DocFingerprintInput[] = nonStateDocs.map((doc) => ({
      path: relative(docsDir, doc.path),
      content: existsSync(doc.path) ? readFileSync(doc.path, "utf8") : "",
    }));
    const fingerprint = computeDocsFingerprint(fingerprintInputs);

    const verdict: {
      stateExists: boolean;
      statePath: string;
      fingerprint: string;
      needsProsePass?: boolean;
      mode?: "seed" | "refresh";
      reason?: string;
      changedDocs?: string[];
    } = { stateExists: existsSync(statePath), statePath, fingerprint };

    // Prose-pass directive is gated on an explicit binding of the current
    // session to this task — never the most-recent-task fallback.
    if (
      verdict.stateExists &&
      nonStateDocs.length > 0 &&
      isSessionBoundTo(store, ctx.env, task.id)
    ) {
      const content = readFileSync(statePath, "utf8");
      const seeding = !hasProseBody(content);
      const marker = readProseFingerprint(content);
      // Drift: a missing/garbled marker, or one that no longer matches the
      // current docs. A freshly-seeded scaffold (no prose yet) always drifts.
      const drifted = seeding || marker !== fingerprint;
      verdict.needsProsePass = drifted;
      if (drifted) {
        verdict.mode = seeding ? "seed" : "refresh";
        verdict.changedDocs = fingerprintInputs.map((doc) => doc.path).sort();
        verdict.reason =
          verdict.mode === "seed"
            ? `state.md has no prose yet — write the living-state prose, then run \`trace state reflect ${task.slug}\` to stamp it.`
            : `state.md prose has drifted from the current docs — update it, then run \`trace state reflect ${task.slug}\` to stamp it.`;
      }
    }

    return success(`${JSON.stringify(verdict)}\n`);
  });
}

// True when the live session (resolved from env) exists and is explicitly bound
// to `taskId`. Mirrors the strict-binding contract: an unbound session, or one
// bound to a different task, does not qualify.
function isSessionBoundTo(store: Store, env: Env, taskId: string): boolean {
  const { id } = inferSessionIdentity(env);
  if (!id) return false;
  return store.getSession(id)?.taskId === taskId;
}
