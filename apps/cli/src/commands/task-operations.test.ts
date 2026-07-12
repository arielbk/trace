import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTraceStore } from "@trace/core";
import { expect, test } from "vitest";
import {
  taskCaptureOperation,
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

test("task update changes the title and keeps the slug", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();

    const updated = taskUpdateOperation([slug, "--title", "Cart wizard"], ctx);

    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("title: Cart wizard\n");
    expect(updated.stdout).toContain("slug: checkout-flow\n");

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      expect(store.getTaskByRef(slug)?.title).toBe("Cart wizard");
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

test("task capture defaults the doc title to the task title", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "some captured body\n");

    const result = taskCaptureOperation(["Captured task", "--doc", docPath], ctx);
    expect(result.exitCode).toBe(0);
    const taskId = result.stdout.trim();

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      const [doc] = store.listDocsForTask(taskId);
      expect(doc?.title).toBe("Captured task");
    } finally {
      store.close();
    }
  });
});

test("task capture --title and --description persist on the doc", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "some captured body\n");

    const result = taskCaptureOperation(
      [
        "Captured task",
        "--doc",
        docPath,
        "--title",
        "Spec sketch",
        "--description",
        "First cut",
      ],
      ctx,
    );
    expect(result.exitCode).toBe(0);
    const taskId = result.stdout.trim();

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      const [doc] = store.listDocsForTask(taskId);
      expect(doc?.title).toBe("Spec sketch");
      expect(doc?.description).toBe("First cut");
    } finally {
      store.close();
    }
  });
});

test("task capture without --description still exits 0 but prints a reminder", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "some captured body\n");

    const result = taskCaptureOperation(["Captured task", "--doc", docPath], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--description");
    // The reminder must point at `update-doc`: `add-doc` no-ops on the doc
    // capture just created (existing (task_id, path) row returns early).
    expect(result.stderr).toContain("task update-doc");
    expect(result.stderr).not.toContain("task add-doc");

    const taskId = result.stdout.trim();
    expect(taskId.length).toBeGreaterThan(0);
  });
});

test("task capture with --description stays quiet", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "some captured body\n");

    const result = taskCaptureOperation(
      ["Captured task", "--doc", docPath, "--description", "All set"],
      ctx,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
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
