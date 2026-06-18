import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { attempt, resolveProjectRoot } from "./seam.ts";

test("attempt returns ok value when the step succeeds", () => {
  expect(attempt(() => "parsed")).toEqual({ ok: true, value: "parsed" });
});

test("attempt converts a thrown error into a failure result", () => {
  const result = attempt(() => {
    throw new Error("bad args");
  });

  expect(result).toEqual({
    ok: false,
    result: { exitCode: 2, stdout: "", stderr: "bad args\n" },
  });
});

test("resolveProjectRoot resolves a valid --project override", () => {
  const parent = mkdtempSync(join(tmpdir(), "trace-seam-project-"));
  const repo = join(parent, "repo");
  const nested = join(repo, "packages", "cli");

  try {
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".git"));

    expect(resolveProjectRoot(nested, parent)).toEqual({
      ok: true,
      value: repo,
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveProjectRoot returns a failure result for an invalid --project override", () => {
  const cwd = mkdtempSync(join(tmpdir(), "trace-seam-missing-"));

  try {
    const missing = join(cwd, "missing");

    expect(resolveProjectRoot(missing, cwd)).toEqual({
      ok: false,
      result: {
        exitCode: 2,
        stdout: "",
        stderr: `--project path does not exist: ${missing}\n`,
      },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
