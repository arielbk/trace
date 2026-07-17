import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTraceStore, resolveTaskDocsDir } from "@trace/core";
import { expect, test } from "vitest";
import { taskCreateOperation } from "./task-operations.ts";
import {
  stateCheckOperation,
  stateReflectOperation,
} from "./state-operations.ts";
import type { Env } from "./seam.ts";

function withoutSessionEnv(env: Env): Env {
  const cleaned = { ...env };
  delete cleaned.CLAUDE_CODE_SESSION_ID;
  delete cleaned.CLAUDE_SESSION_ID;
  delete cleaned.session_id;
  delete cleaned.CODEX_THREAD_ID;
  delete cleaned.CURSOR_CONVERSATION_ID;
  return cleaned;
}

function withTempContext(
  run: (ctx: { env: Env; cwd: string; stdin: string }) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-state-ops-"));
  const env = withoutSessionEnv({
    ...process.env,
    TRACE_DB: join(dir, "trace.sqlite"),
  });
  try {
    run({ env, cwd: dir, stdin: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Register a native doc under the task's docs dir without rendering state.md,
// reproducing the "native doc present, state.md absent" precondition.
function seedNativeDoc(
  ctx: { env: Env },
  slug: string,
  fileName: string,
  body: string,
): string {
  const databasePath = ctx.env.TRACE_DB as string;
  const store = openTraceStore(databasePath);
  try {
    const task = store.getTaskByRef(slug);
    if (!task) throw new Error(`task not found: ${slug}`);
    const docsDir = resolveTaskDocsDir(databasePath, task.slug);
    mkdirSync(docsDir, { recursive: true });
    const docPath = join(docsDir, fileName);
    writeFileSync(docPath, body);
    store.addTaskDoc(task.id, docPath, { description: "The spec" });
    return join(docsDir, "state.md");
  } finally {
    store.close();
  }
}

// Bind a Claude session to the task and surface that session id on the env, so
// `state check` resolves an explicit binding (the prose-pass gate).
function bindSession(ctx: { env: Env }, slug: string, sessionId: string): void {
  const databasePath = ctx.env.TRACE_DB as string;
  const store = openTraceStore(databasePath);
  try {
    const task = store.getTaskByRef(slug);
    if (!task) throw new Error(`task not found: ${slug}`);
    store.registerSession({
      id: sessionId,
      transcriptPath: `claude:${sessionId}`,
      tool: "claude",
    });
    store.assignSession(sessionId, task.id);
  } finally {
    store.close();
  }
  ctx.env.CLAUDE_CODE_SESSION_ID = sessionId;
}

test("state check creates state.md with the rendered footer for a task with a native doc", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const statePath = seedNativeDoc(ctx, slug, "spec.md", "Spec body, no heading.\n");
    expect(existsSync(statePath)).toBe(false);

    const result = stateCheckOperation([slug], ctx);

    expect(result.exitCode).toBe(0);
    const verdict = JSON.parse(result.stdout);
    expect(verdict.stateExists).toBe(true);
    expect(verdict.statePath).toBe(statePath);

    const written = readFileSync(statePath, "utf8");
    expect(written).toContain("# Checkout flow");
    expect(written).toContain("- [spec.md](spec.md) — The spec");
  });
});

test("state check is a byte-identical no-op on a second run", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const statePath = seedNativeDoc(ctx, slug, "spec.md", "# Spec\n");

    stateCheckOperation([slug], ctx);
    const first = readFileSync(statePath, "utf8");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(statePath, past, past);
    const beforeMtime = statSync(statePath).mtimeMs;

    stateCheckOperation([slug], ctx);

    expect(readFileSync(statePath, "utf8")).toBe(first);
    expect(statSync(statePath).mtimeMs).toBe(beforeMtime);
  });
});

test("state check abstains from needsProsePass when the session has no explicit binding", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    seedNativeDoc(ctx, slug, "spec.md", "Spec body, no heading.\n");

    const verdict = JSON.parse(stateCheckOperation([slug], ctx).stdout);

    expect(verdict.needsProsePass).toBeUndefined();
    // The footer still reconciles even without a binding.
    expect(verdict.stateExists).toBe(true);
    // The fingerprint is always reported.
    expect(typeof verdict.fingerprint).toBe("string");
    expect(verdict.fingerprint.length).toBeGreaterThan(0);
  });
});

test("state check seeds: needsProsePass with mode=seed when bound and no prose body", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    seedNativeDoc(ctx, slug, "spec.md", "Spec body, no heading.\n");
    bindSession(ctx, slug, "session-seed");

    const verdict = JSON.parse(stateCheckOperation([slug], ctx).stdout);

    expect(verdict.needsProsePass).toBe(true);
    expect(verdict.mode).toBe("seed");
    expect(verdict.reason).toContain("trace state reflect");
    expect(verdict.changedDocs).toContain("spec.md");
  });
});

test("state check drifts: mode=refresh when bound, prose present, but marker absent", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const statePath = seedNativeDoc(ctx, slug, "spec.md", "Spec body.\n");
    bindSession(ctx, slug, "session-refresh");

    // First check seeds the footer; then a human writes prose above it.
    stateCheckOperation([slug], ctx);
    const seeded = readFileSync(statePath, "utf8");
    writeFileSync(
      statePath,
      seeded.replace("# Checkout flow\n", "# Checkout flow\n\n## Summary\n\nDid the thing.\n"),
    );

    const verdict = JSON.parse(stateCheckOperation([slug], ctx).stdout);

    expect(verdict.needsProsePass).toBe(true);
    expect(verdict.mode).toBe("refresh");
    // Refresh is advisory — the agent judges whether the drift warrants a
    // pass — but still names the reflect command that stamps the marker.
    expect(verdict.reason).toContain("Use your judgment");
    expect(verdict.reason).toContain(`trace state reflect ${slug}`);
  });
});

test("state check is a no-op verdict when the marker matches the current fingerprint", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const statePath = seedNativeDoc(ctx, slug, "spec.md", "Spec body.\n");
    bindSession(ctx, slug, "session-clean");

    // Seed the footer, write prose, and stamp the current fingerprint marker.
    const firstVerdict = JSON.parse(stateCheckOperation([slug], ctx).stdout);
    const seeded = readFileSync(statePath, "utf8");
    const withProseAndMarker = seeded.replace(
      "# Checkout flow\n",
      `# Checkout flow\n\n## Summary\n\nDid the thing.\n\n<!-- trace:prose-fingerprint:${firstVerdict.fingerprint} -->\n`,
    );
    writeFileSync(statePath, withProseAndMarker);

    const verdict = JSON.parse(stateCheckOperation([slug], ctx).stdout);

    expect(verdict.needsProsePass).toBe(false);
  });
});

test("state reflect then check returns a no-op verdict (needsProsePass false)", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const statePath = seedNativeDoc(ctx, slug, "spec.md", "Spec body.\n");
    bindSession(ctx, slug, "session-reflect");

    // Seed the footer, then a human writes prose above it.
    stateCheckOperation([slug], ctx);
    const seeded = readFileSync(statePath, "utf8");
    writeFileSync(
      statePath,
      seeded.replace("# Checkout flow\n", "# Checkout flow\n\n## Summary\n\nDid the thing.\n"),
    );

    stateReflectOperation([slug], ctx);

    const verdict = JSON.parse(stateCheckOperation([slug], ctx).stdout);
    expect(verdict.needsProsePass).toBe(false);
  });
});

test("state reflect preserves the prose and the docs-manifest fence", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const statePath = seedNativeDoc(ctx, slug, "spec.md", "Spec body.\n");
    bindSession(ctx, slug, "session-preserve");

    stateCheckOperation([slug], ctx);
    const seeded = readFileSync(statePath, "utf8");
    writeFileSync(
      statePath,
      seeded.replace("# Checkout flow\n", "# Checkout flow\n\n## Summary\n\nDid the thing.\n"),
    );

    stateReflectOperation([slug], ctx);

    const written = readFileSync(statePath, "utf8");
    // Prose above the fence is preserved.
    expect(written).toContain("## Summary");
    expect(written).toContain("Did the thing.");
    // The docs-manifest fence is preserved.
    expect(written).toContain("<!-- trace:docs-manifest:start -->");
    expect(written).toContain("- [spec.md](spec.md) — The spec");
    // The prose marker is stamped above the fence.
    const markerIdx = written.indexOf("<!-- trace:prose-fingerprint:");
    const fenceIdx = written.indexOf("<!-- trace:docs-manifest:start -->");
    expect(markerIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeLessThan(fenceIdx);
  });
});

test("state reflect advances the marker even when prose text is unchanged", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const databasePath = ctx.env.TRACE_DB as string;
    const docsDir = resolveTaskDocsDir(databasePath, slug);
    const statePath = seedNativeDoc(ctx, slug, "spec.md", "Spec body.\n");
    bindSession(ctx, slug, "session-advance");

    stateCheckOperation([slug], ctx);
    const seeded = readFileSync(statePath, "utf8");
    writeFileSync(
      statePath,
      seeded.replace("# Checkout flow\n", "# Checkout flow\n\n## Summary\n\nDid the thing.\n"),
    );

    stateReflectOperation([slug], ctx);
    const markerA = JSON.parse(stateReflectOperation([slug], ctx).stdout).fingerprint;

    // Change a doc on disk so the docs fingerprint moves; prose text is left alone.
    writeFileSync(join(docsDir, "spec.md"), "Spec body, revised.\n");

    const markerB = JSON.parse(stateReflectOperation([slug], ctx).stdout).fingerprint;
    expect(markerB).not.toBe(markerA);

    const written = readFileSync(statePath, "utf8");
    expect(written).toContain("## Summary");
    expect(written).toContain(`<!-- trace:prose-fingerprint:${markerB} -->`);
  });
});

test("state reflect is a byte-identical no-op on repeat", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const statePath = seedNativeDoc(ctx, slug, "spec.md", "Spec body.\n");
    bindSession(ctx, slug, "session-idempotent");

    stateCheckOperation([slug], ctx);
    const seeded = readFileSync(statePath, "utf8");
    writeFileSync(
      statePath,
      seeded.replace("# Checkout flow\n", "# Checkout flow\n\n## Summary\n\nDid the thing.\n"),
    );

    stateReflectOperation([slug], ctx);
    const first = readFileSync(statePath, "utf8");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(statePath, past, past);
    const beforeMtime = statSync(statePath).mtimeMs;

    stateReflectOperation([slug], ctx);

    expect(readFileSync(statePath, "utf8")).toBe(first);
    expect(statSync(statePath).mtimeMs).toBe(beforeMtime);
  });
});

test("state check does not create state.md for a task with zero non-state docs", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
    const databasePath = ctx.env.TRACE_DB as string;
    const statePath = join(resolveTaskDocsDir(databasePath, slug), "state.md");

    const result = stateCheckOperation([slug], ctx);

    expect(result.exitCode).toBe(0);
    const verdict = JSON.parse(result.stdout);
    expect(verdict.stateExists).toBe(false);
    expect(verdict.statePath).toBe(statePath);
    expect(existsSync(statePath)).toBe(false);
  });
});
