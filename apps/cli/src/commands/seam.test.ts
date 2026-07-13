import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "@trace/core";
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
  const store = openTraceStore(join(parent, "trace.sqlite"));

  try {
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".git"));

    expect(resolveProjectRoot(nested, parent, store)).toEqual({
      ok: true,
      value: repo,
    });
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveProjectRoot resolves an exact project slug before treating it as a path", () => {
  const parent = mkdtempSync(join(tmpdir(), "trace-seam-slug-"));
  const repo = join(parent, "checkout-app");
  const unrelatedCwd = join(parent, "sandbox");
  const store = openTraceStore(join(parent, "trace.sqlite"));

  try {
    mkdirSync(repo);
    mkdirSync(join(repo, ".git"));
    mkdirSync(unrelatedCwd);
    const project = store.resolveProject(repo).project;

    expect(resolveProjectRoot(project.slug, unrelatedCwd, store)).toEqual({
      ok: true,
      value: repo,
    });
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveProjectRoot returns a failure result for an invalid --project override", () => {
  const cwd = mkdtempSync(join(tmpdir(), "trace-seam-missing-"));
  const store = openTraceStore(join(cwd, "trace.sqlite"));

  try {
    const missing = join(cwd, "missing");

    expect(resolveProjectRoot(missing, cwd, store)).toEqual({
      ok: false,
      result: {
        exitCode: 2,
        stdout: "",
        stderr: `--project path does not exist: ${missing}\n`,
      },
    });
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
