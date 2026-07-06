import { describe, expect, test } from "vitest";
import { resumeCommand } from "./resume.ts";

describe("resumeCommand", () => {
  test("builds a Claude resume command", () => {
    expect(resumeCommand({ tool: "claude", id: "claude-session-1" })).toBe(
      "claude --resume claude-session-1",
    );
  });

  test("builds a Codex resume command", () => {
    expect(resumeCommand({ tool: "codex", id: "codex-session-1" })).toBe(
      "codex resume codex-session-1",
    );
  });

  test("yields no resume command for a Cursor session", () => {
    expect(resumeCommand({ tool: "cursor", id: "composer-1" })).toBeNull();
  });
});
