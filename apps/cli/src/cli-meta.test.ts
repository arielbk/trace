import { expect, test } from "vitest";
import { runTraceCli, runTraceCliAsync } from "./trace.ts";

test.each(["--version", "-v", "version"])(
  "%s prints the running EQNX version",
  async (argument) => {
    const result = await runTraceCliAsync(
      [argument],
      { TRACE_CURRENT_VERSION: "1.2.3" },
      process.cwd(),
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "eqnx 1.2.3\n",
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
  expect(result.stdout).toContain("Usage: eqnx init | eqnx setup");
  expect(result.stdout).toContain("eqnx session");
  expect(result.stdout).toContain("eqnx skill");
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
  expect(result.stdout).toContain("EQNX v1.2.3");
  expect(result.stdout).toContain("Get started");
  expect(result.stdout).toContain("eqnx setup");
  expect(result.stdout).toContain("eqnx serve");
  expect(result.stdout).toContain("eqnx task list");
  expect(result.stdout).toContain("eqnx <command> --help");
  expect(result.stdout).not.toContain("eqnx init | eqnx setup");
  expect(result.stdout).toContain("\u001B[");
});

test.each([
  ["NO_COLOR", { NO_COLOR: "1" }],
  ["a dumb terminal", { TERM: "dumb" }],
])("%s disables terminal help colors", async (_label, terminalEnv) => {
  const result = await runTraceCliAsync(
    ["--help"],
    { TRACE_CURRENT_VERSION: "1.2.3", ...terminalEnv },
    process.cwd(),
    "",
    { humanReadable: true },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("\u001B[");
  expect(result.stdout).toContain("EQNX v1.2.3");
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

test("eqnx connection is routed and listed among the commands", async () => {
  const result = await runTraceCliAsync(
    ["connection"],
    { TRACE_CURRENT_VERSION: "1.2.3" },
    process.cwd(),
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Usage: eqnx connection");
  expect(
    runTraceCli(["--help"], { TRACE_CURRENT_VERSION: "1.2.3" }, process.cwd())
      .stdout,
  ).toContain("eqnx connection");
});

test("eqnx board is routed and offered as the way to open the board", async () => {
  const result = await runTraceCliAsync(
    ["board", "--hosted"],
    { TRACE_CURRENT_VERSION: "1.2.3" },
    process.cwd(),
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Usage: eqnx board [--local]");
  expect(
    runTraceCli(["--help"], { TRACE_CURRENT_VERSION: "1.2.3" }, process.cwd())
      .stdout,
  ).toContain("eqnx board");

  const humanReadableHelp = await runTraceCliAsync(
    ["--help"],
    { TRACE_CURRENT_VERSION: "1.2.3" },
    process.cwd(),
    "",
    { humanReadable: true },
  );
  expect(humanReadableHelp.stdout).toContain("eqnx board");
});

test("terminal help points at the connection commands that recover a board", async () => {
  const result = await runTraceCliAsync(
    ["--help"],
    { TRACE_CURRENT_VERSION: "1.2.3" },
    process.cwd(),
    "",
    { humanReadable: true },
  );

  // Someone whose hosted board stopped connecting has one question — what do I
  // run? — and `eqnx --help` is where they ask it.
  expect(result.stdout).toContain("eqnx connection status");
});


test("pair help and invalid arguments use the short command without contacting a service", async () => {
  const help = await runTraceCliAsync(["pair", "--help"], {});
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("Usage: eqnx pair [<code>|--open]");
  const invalid = await runTraceCliAsync(["pair", "--unknown"], {});
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain("Usage: eqnx pair [<code>|--open]");
});
