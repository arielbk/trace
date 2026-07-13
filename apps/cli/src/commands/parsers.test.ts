import { join } from "node:path";
import { expect, test } from "vitest";
import {
  parseClaudeScanArgs,
  parseCodexScanArgs,
  parseSessionRegisterArgs,
  parseSessionSetParentArgs,
  parseTaskCreateArgs,
  parseTaskUpdateArgs,
  parseUpdateDocOptions,
  sessionRegisterUsage,
  sessionSetParentUsage,
  taskCreateUsage,
  taskUpdateUsage,
  updateDocUsage,
} from "./parsers.ts";

test("parseUpdateDocOptions parses non-empty title and description as set values", () => {
  expect(
    parseUpdateDocOptions(["--title", "Checkout Spec", "--description", "The spec"]),
  ).toEqual({ title: "Checkout Spec", description: "The spec" });
});

test("parseUpdateDocOptions maps an empty flag value to null and omits absent flags", () => {
  // Empty --description clears (null); --title is absent so it stays untouched.
  expect(parseUpdateDocOptions(["--description", ""])).toEqual({
    description: null,
  });
});

test("parseUpdateDocOptions throws usage when neither field is given", () => {
  expect(() => parseUpdateDocOptions([])).toThrow(updateDocUsage());
});

test("parseTaskUpdateArgs accepts --title, --description, or both", () => {
  expect(parseTaskUpdateArgs(["checkout-flow", "--title", "Cart wizard"])).toEqual({
    ref: "checkout-flow",
    title: "Cart wizard",
    description: undefined,
  });
  expect(
    parseTaskUpdateArgs([
      "checkout-flow",
      "--title",
      "Cart wizard",
      "--description",
      "Second pass",
    ]),
  ).toEqual({
    ref: "checkout-flow",
    title: "Cart wizard",
    description: "Second pass",
  });
});

test("parseTaskUpdateArgs throws the usage string when no field is given", () => {
  expect(() => parseTaskUpdateArgs(["checkout-flow"])).toThrow(
    taskUpdateUsage(),
  );
});

test("parseTaskCreateArgs parses a title with optional description and project", () => {
  expect(
    parseTaskCreateArgs([
      "Ship",
      "the",
      "thing",
      "--description",
      "Useful context",
      "--project",
      "/repo",
    ]),
  ).toEqual({
    title: "Ship the thing",
    description: "Useful context",
    project: "/repo",
  });
});

test("parseTaskCreateArgs throws the usage string when the title is missing", () => {
  expect(() => parseTaskCreateArgs(["--description", "no title"])).toThrow(
    taskCreateUsage(),
  );
});

test("parseSessionRegisterArgs parses required fields and token totals", () => {
  expect(
    parseSessionRegisterArgs([
      "--id",
      "session-1",
      "--transcript",
      "/tmp/transcript.jsonl",
      "--tool",
      "codex",
      "--model",
      "gpt-5-codex",
      "--origin",
      "spawned",
      "--input-tokens",
      "12",
    ]),
  ).toEqual({
    id: "session-1",
    transcriptPath: "/tmp/transcript.jsonl",
    tool: "codex",
    model: "gpt-5-codex",
    parentSessionId: undefined,
    origin: "spawned",
    tokenTotals: { inputTokens: 12 },
  });
});

test("parseSessionRegisterArgs throws the usage string when required fields are missing", () => {
  expect(() => parseSessionRegisterArgs(["--id", "session-1"])).toThrow(
    sessionRegisterUsage(),
  );
});

test("parseSessionSetParentArgs parses a child session, parent, and origin", () => {
  expect(
    parseSessionSetParentArgs([
      "child-session",
      "--parent",
      "parent-session",
      "--origin",
      "subagent",
    ]),
  ).toEqual({
    id: "child-session",
    parentSessionId: "parent-session",
    origin: "subagent",
  });
});

test("parseSessionSetParentArgs throws the usage string when the child id is missing", () => {
  expect(() => parseSessionSetParentArgs(["--parent", "parent-session"])).toThrow(
    sessionSetParentUsage(),
  );
});

test("parseSessionSetParentArgs parses --tool and --transcript", () => {
  expect(
    parseSessionSetParentArgs([
      "child-session",
      "--parent",
      "parent-session",
      "--origin",
      "spawned",
      "--tool",
      "claude",
      "--transcript",
      "/tmp/child-session.jsonl",
    ]),
  ).toEqual({
    id: "child-session",
    parentSessionId: "parent-session",
    origin: "spawned",
    tool: "claude",
    transcriptPath: "/tmp/child-session.jsonl",
  });
});

test("parseSessionSetParentArgs leaves tool and transcript unset when absent", () => {
  expect(
    parseSessionSetParentArgs(["child-session", "--parent", "parent-session"]),
  ).toEqual({
    id: "child-session",
    parentSessionId: "parent-session",
    origin: "spawned",
  });
});

test("parseSessionSetParentArgs rejects an invalid --tool value", () => {
  expect(() =>
    parseSessionSetParentArgs([
      "child-session",
      "--parent",
      "parent-session",
      "--tool",
      "gemini",
    ]),
  ).toThrow("Session tool must be claude, codex, or cursor");
});

test("parseCodexScanArgs falls back to USERPROFILE when HOME is unset (native Windows)", () => {
  expect(parseCodexScanArgs([], { USERPROFILE: "C:\\Users\\user" })).toBe(
    join("C:\\Users\\user", ".codex"),
  );
});

test("parseCodexScanArgs prefers HOME over USERPROFILE when both are set", () => {
  expect(
    parseCodexScanArgs([], { HOME: "/home/user", USERPROFILE: "C:\\Users\\user" }),
  ).toBe(join("/home/user", ".codex"));
});

test("parseCodexScanArgs throws without --codex-home when no home variable is set", () => {
  expect(() => parseCodexScanArgs([], {})).toThrow();
});

test("parseClaudeScanArgs falls back to USERPROFILE when HOME is unset (native Windows)", () => {
  expect(parseClaudeScanArgs([], { USERPROFILE: "C:\\Users\\user" })).toBe(
    join("C:\\Users\\user", ".claude", "projects"),
  );
});

test("parseClaudeScanArgs prefers HOME over USERPROFILE when both are set", () => {
  expect(
    parseClaudeScanArgs([], { HOME: "/home/user", USERPROFILE: "C:\\Users\\user" }),
  ).toBe(join("/home/user", ".claude", "projects"));
});

test("parseClaudeScanArgs throws without --projects-root when no home variable is set", () => {
  expect(() => parseClaudeScanArgs([], {})).toThrow();
});
