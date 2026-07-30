import { expect, test } from "vitest";
import { runTraceCli, runTraceCliAsync } from "./trace.ts";

test.each(["--version", "-v", "version"])(
  "%s prints the running Trace version",
  async (argument) => {
    const result = await runTraceCliAsync(
      [argument],
      { TRACE_CURRENT_VERSION: "1.2.3" },
      process.cwd(),
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "trace 1.2.3\n",
      stderr: "",
    });
  },
);

test("non-terminal help remains compact and exhaustive", () => {
  const result = runTraceCli(
    ["--help"],
    { TRACE_CURRENT_VERSION: "1.2.3" },
    process.cwd(),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Usage: trace init | trace setup");
  expect(result.stdout).toContain("trace session");
  expect(result.stdout).toContain("trace skill");
});

test("terminal help leads with human workflows instead of the exhaustive command list", async () => {
  const result = await runTraceCliAsync(
    ["--help"],
    { TRACE_CURRENT_VERSION: "1.2.3" },
    process.cwd(),
    "",
    { humanReadable: true },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Trace v1.2.3");
  expect(result.stdout).toContain("Get started");
  expect(result.stdout).toContain("trace setup");
  expect(result.stdout).toContain("trace serve");
  expect(result.stdout).toContain("trace task list");
  expect(result.stdout).toContain("trace <command> --help");
  expect(result.stdout).not.toContain("trace init | trace setup");
});

test("bare terminal invocation shows human help successfully", async () => {
  const result = await runTraceCliAsync(
    [],
    { TRACE_CURRENT_VERSION: "1.2.3" },
    process.cwd(),
    "",
    { humanReadable: true },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Get started");
  expect(result.stderr).toBe("");
});
