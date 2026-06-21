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
import { stateCheckOperation } from "./state-operations.ts";
import type { Env } from "./seam.ts";

function withTempContext(run: (ctx: { env: Env; cwd: string; stdin: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-state-ops-"));
  const env: Env = { ...process.env, TRACE_DB: join(dir, "trace.sqlite") };
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
