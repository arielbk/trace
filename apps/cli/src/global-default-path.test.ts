import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

test("trace task list uses ~/.trace/trace.sqlite when TRACE_DB is unset", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "trace-home-"));

  try {
    const env: Record<string, string | undefined> = { HOME: fakeHome };

    const result = runTraceCli(["task", "list"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    const expectedDb = join(fakeHome, ".trace", "trace.sqlite");
    expect(existsSync(expectedDb)).toBe(true);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
