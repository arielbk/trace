import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rootPackageJson = join(repoRoot, "package.json");

test("root package exposes trace bin that runs from outside the repo", () => {
  const packageJson = JSON.parse(readFileSync(rootPackageJson, "utf8")) as {
    bin?: Record<string, string>;
  };
  const traceBin = packageJson.bin?.trace;

  expect(traceBin).toBe("apps/cli/src/trace.ts");
  if (!traceBin) {
    throw new Error("trace bin is missing from the root package");
  }

  const outsideDir = mkdtempSync(join(tmpdir(), "trace-outside-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "trace-home-"));

  try {
    const listed = execFileSync(
      process.execPath,
      [resolve(repoRoot, traceBin), "task", "list"],
      {
        cwd: outsideDir,
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, TRACE_DB: undefined },
      },
    );

    expect(listed).toBe("");
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
