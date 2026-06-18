import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTraceStore } from "@trace/core";
import { expect, test } from "vitest";
import {
  taskCreateOperation,
  taskListOperation,
  taskShowOperation,
  taskUpdateOperation,
} from "./task-operations.ts";
import type { Env } from "./seam.ts";

function withTempContext(run: (ctx: { env: Env; cwd: string; stdin: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-task-ops-"));
  const env: Env = { ...process.env, TRACE_DB: join(dir, "trace.sqlite") };

  try {
    run({ env, cwd: dir, stdin: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("task create and show round-trip through direct operations", () => {
  withTempContext((ctx) => {
    expect(
      taskCreateOperation(
        ["Checkout flow", "--description", "Tighten the cart path"],
        ctx,
      ),
    ).toEqual({ exitCode: 0, stdout: "checkout-flow\n", stderr: "" });

    const shown = taskShowOperation(["checkout-flow"], ctx);

    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("slug: checkout-flow\n");
    expect(shown.stdout).toContain("title: Checkout flow\n");
    expect(shown.stdout).toContain("description: Tighten the cart path\n");
  });
});

test("task update changes the persisted description", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();

    const updated = taskUpdateOperation(
      [slug, "--description", "Second pass"],
      ctx,
    );

    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("description: Second pass\n");

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      expect(store.getTaskByRef(slug)?.description).toBe("Second pass");
    } finally {
      store.close();
    }
  });
});

test("task list prints task summaries", () => {
  withTempContext((ctx) => {
    taskCreateOperation(["Checkout"], ctx);
    taskCreateOperation(["Review"], ctx);

    expect(taskListOperation([], ctx)).toEqual({
      exitCode: 0,
      stdout: "checkout\tCheckout\nreview\tReview\n",
      stderr: "",
    });
  });
});

test("task show reports a missing ref with exit code 1", () => {
  withTempContext((ctx) => {
    expect(taskShowOperation(["missing"], ctx)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Task not found: missing\n",
    });
  });
});
