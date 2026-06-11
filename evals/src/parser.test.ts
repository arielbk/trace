import { describe, expect, test } from "vitest";
import { parse } from "./parser.ts";

// Helpers that build NDJSON strings from event objects.
const ndjson = (...events: unknown[]) =>
  events.map((e) => JSON.stringify(e)).join("\n");

// Minimal stream event shapes that match what `claude -p --output-format
// stream-json --verbose` actually emits (one JSON object per line).

const systemInit = {
  type: "system",
  subtype: "init",
  session_id: "sess_abc",
  tools: ["Skill"],
  model: "claude-opus-4-7",
};

function assistantWithSkill(skill: string) {
  return {
    type: "assistant",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Skill",
          input: { skill },
        },
      ],
      stop_reason: "tool_use",
    },
  };
}

const resultEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
};

describe("parse", () => {
  test("extracts the fired skill name from a single-skill stream", () => {
    const stream = ndjson(systemInit, assistantWithSkill("trace"), resultEvent);
    expect(parse(stream)).toEqual(["trace"]);
  });

  test("returns empty array when no Skill tool-use is present", () => {
    const stream = ndjson(
      systemInit,
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "No skill fired." }],
        },
      },
      resultEvent,
    );
    expect(parse(stream)).toEqual([]);
  });

  test("returns skills in order when multiple Skill tool-uses fire", () => {
    const stream = ndjson(
      systemInit,
      assistantWithSkill("trace"),
      assistantWithSkill("trace-recall"),
      resultEvent,
    );
    expect(parse(stream)).toEqual(["trace", "trace-recall"]);
  });

  test("tolerates non-JSON noise lines without throwing", () => {
    const stream = [
      "Claude Code running…",
      JSON.stringify(assistantWithSkill("trace-handoff")),
      "some trailing banner",
    ].join("\n");
    expect(parse(stream)).toEqual(["trace-handoff"]);
  });

  test("finds tool_use nested inside a deeply wrapped content array", () => {
    // Defensive: ensures the recursive walk reaches a nested structure.
    const nested = {
      type: "wrapper",
      payload: {
        events: [assistantWithSkill("trace-reenter")],
      },
    };
    expect(parse(JSON.stringify(nested))).toEqual(["trace-reenter"]);
  });

  test("ignores tool_use blocks for tools other than Skill", () => {
    const stream = ndjson({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_02",
            name: "Bash",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "toolu_03",
            name: "Skill",
            input: { skill: "trace-doc-placement" },
          },
        ],
      },
    });
    expect(parse(stream)).toEqual(["trace-doc-placement"]);
  });

  test("returns empty array for an empty string", () => {
    expect(parse("")).toEqual([]);
  });
});
