import { describe, expect, test } from "vitest";
import { formatReport, formatSummary } from "./reporter.ts";
import type { EvalResult } from "../run.ts";

const pass = (utterance: string, skill: string): EvalResult => ({
  utterance,
  expected: skill,
  fired: skill,
  pass: true,
  note: "",
});

const fail = (utterance: string, expected: string, fired: string): EvalResult => ({
  utterance,
  expected,
  fired,
  pass: false,
  note: "",
});

describe("formatReport", () => {
  test("renders a PASS row with utterance, expected, fired, and verdict columns", () => {
    const results = [pass("let's start tracing this feature", "trace")];
    const report = formatReport(results);
    expect(report).toContain("let's start tracing this feature");
    expect(report).toContain("trace");
    expect(report).toContain("PASS");
  });

  test("renders a FAIL row with mismatched expected and fired", () => {
    const results = [fail("open the board", "trace-board", "trace")];
    const report = formatReport(results);
    expect(report).toContain("open the board");
    expect(report).toContain("trace-board");
    expect(report).toContain("trace");
    expect(report).toContain("FAIL");
  });

  test("renders one row per result", () => {
    const results = [
      pass("trace this", "trace"),
      pass("recall context", "trace-recall"),
      fail("reenter task", "trace-reenter", "trace"),
    ];
    const report = formatReport(results);
    const lines = report.split("\n").filter((l) => l.trim());
    // header + separator + 3 data rows = at least 5 lines
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(report).toContain("trace this");
    expect(report).toContain("recall context");
    expect(report).toContain("reenter task");
  });

  test("renders header with column names", () => {
    const report = formatReport([pass("x", "trace")]);
    const header = report.toLowerCase();
    expect(header).toContain("utterance");
    expect(header).toContain("expected");
    expect(header).toContain("fired");
    expect(header).toContain("verdict");
  });
});

describe("formatSummary", () => {
  test("all-pass summary: N/N passed", () => {
    const results = [pass("a", "trace"), pass("b", "trace-recall")];
    expect(formatSummary(results)).toBe("2/2 passed");
  });

  test("some-fail summary: includes failed count", () => {
    const results = [
      pass("a", "trace"),
      fail("b", "trace-recall", "trace"),
      fail("c", "trace-reenter", "<none>"),
    ];
    expect(formatSummary(results)).toBe("1/3 passed, 2 failed");
  });

  test("all-fail summary", () => {
    const results = [fail("x", "trace", "<none>")];
    expect(formatSummary(results)).toBe("0/1 passed, 1 failed");
  });

  test("empty results: 0/0 passed", () => {
    expect(formatSummary([])).toBe("0/0 passed");
  });
});
