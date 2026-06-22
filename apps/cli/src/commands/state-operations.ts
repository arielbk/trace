import {
  computeDocsFingerprint,
  hasProseBody,
  inferSessionIdentity,
  readProseFingerprint,
  renderManifest,
  renderProseMarker,
  resolveTaskDocsDir,
  stripFence,
  type DocFingerprintInput,
} from "@trace/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
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
            ? `state.md has no prose yet — invoke the \`trace-state\` skill to write the living-state prose (it stamps via \`trace state reflect ${task.slug}\` when done).`
            : `state.md prose has drifted from the current docs — invoke the \`trace-state\` skill to refresh it (it stamps via \`trace state reflect ${task.slug}\` when done).`;
      }
    }

    return success(`${JSON.stringify(verdict)}\n`);
  });
}

// Global form of the prose marker, used to strip any prior marker before
// stamping a fresh one. Mirrors the pattern owned by `prose-fingerprint.ts`.
const PROSE_MARKER_GLOBAL =
  /<!--\s*trace:prose-fingerprint:[0-9a-f]+\s*-->/g;

// `trace state reflect <task>` — recompute the current docs fingerprint and
// stamp it into state.md's machine-owned prose marker, preserving the prose
// above the docs-manifest fence and the fence itself. Run by a human (or hook)
// after the living-state prose has been written/updated, so a subsequent
// `trace state check` sees the prose as reconciled with the current docs.
export function stateReflectOperation(
  rawArgs: string[],
  ctx: CommandContext,
): CommandResult {
  if (isHelpFlag(rawArgs[0]))
    return success("Usage: trace state reflect <task>\n");
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

    const fingerprintInputs: DocFingerprintInput[] = nonStateDocs.map((doc) => ({
      path: relative(docsDir, doc.path),
      content: existsSync(doc.path) ? readFileSync(doc.path, "utf8") : "",
    }));
    const fingerprint = computeDocsFingerprint(fingerprintInputs);

    // With no non-state doc there is nothing to reflect on; mirror `check` and
    // leave state.md untouched (it should not exist yet).
    if (nonStateDocs.length === 0) {
      return success(
        `${JSON.stringify({
          stateExists: existsSync(statePath),
          statePath,
          fingerprint,
        })}\n`,
      );
    }

    const present = existsSync(statePath);
    const existing = present
      ? readFileSync(statePath, "utf8")
      : `# ${task.title}\n`;

    // Strip the fence to isolate the authored prose, drop any prior marker, then
    // re-append the freshly-computed marker at the end of the prose. Re-rendering
    // the fence from the current docs restores it below a `---` divider — and is
    // byte-identical when the docs are unchanged.
    const prose = stripFence(existing).replace(PROSE_MARKER_GLOBAL, "");
    const proseWithMarker = `${prose.replace(/\s+$/, "")}\n\n${renderProseMarker(
      fingerprint,
    )}`;
    const entries = buildManifestEntries(store, databasePath, task);
    const next = renderManifest(proseWithMarker, entries);

    // Write-if-changed so repeat reflects (same docs, same prose) are a true
    // byte-identical no-op with no mtime bump.
    if (!present || existing !== next) {
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(statePath, next);
    }

    return success(
      `${JSON.stringify({ stateExists: true, statePath, fingerprint })}\n`,
    );
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
