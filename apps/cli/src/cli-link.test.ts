import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootPackageJson = join(repoRoot, "package.json");
const traceEntry = resolve(repoRoot, "apps/cli/src/trace.ts");

test("root package exposes the trace bin at the TS entry", () => {
  const packageJson = JSON.parse(readFileSync(rootPackageJson, "utf8")) as {
    bin?: Record<string, string>;
  };

  expect(packageJson.bin?.trace).toBe("apps/cli/src/trace.ts");
});

test("trace bin lists global-store tasks when invoked through a symlink from outside the repo", () => {
  // `pnpm link --global` exposes the CLI through a symlink whose path differs
  // from the entry's realpath. The CLI must still detect it is the direct run
  // and execute, listing the seeded task rather than exiting silently.
  const outsideDir = mkdtempSync(join(tmpdir(), "trace-outside-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "trace-home-"));
  const linkDir = mkdtempSync(join(tmpdir(), "trace-link-"));
  const linkedEntry = join(linkDir, "trace.ts");
  symlinkSync(traceEntry, linkedEntry);

  const childEnv = { ...process.env, HOME: fakeHome, TRACE_DB: undefined };

  try {
    execFileSync(
      process.execPath,
      [traceEntry, "task", "create", "cli-link smoke task"],
      { cwd: outsideDir, encoding: "utf8", env: childEnv },
    );

    const listed = execFileSync(
      process.execPath,
      [linkedEntry, "task", "list"],
      { cwd: outsideDir, encoding: "utf8", env: childEnv },
    );

    expect(listed).toContain("cli-link smoke task");
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
  }
});
