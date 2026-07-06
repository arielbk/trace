import { expect, test } from "vitest";
import {
  parseSessionRegisterArgs,
  parseSessionSetParentArgs,
  parseTaskCreateArgs,
  parseUpdateDocOptions,
  sessionRegisterUsage,
  sessionSetParentUsage,
  taskCreateUsage,
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
