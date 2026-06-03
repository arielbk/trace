import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

test("task create stamps and task show prints the resolved project root", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-project-"));
  const databasePath = join(dir, "trace.sqlite");
  const projectRoot = join(dir, "repo");
  const nestedCwd = join(projectRoot, "packages", "app");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });

    const created = runTraceCli(["task", "create", "checkout"], env, nestedCwd);
    expect(created.exitCode).toBe(0);
    expect(created.stderr).toBe("");

    const slug = created.stdout.trim();
    expect(slug).toBe("checkout");

    const shown = runTraceCli(["task", "show", slug], env, nestedCwd);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toMatch(/id: [0-9a-f-]{36}/);
    expect(shown.stdout).toMatch(`slug: ${slug}`);
    expect(shown.stdout).toMatch(`projectRoot: ${projectRoot}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
