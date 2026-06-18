import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { deriveSessionName, resolveSessionName } from "./session-name.ts";

function makeTranscript(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  const lines: string[] = [
    JSON.stringify({ type: "system", session_id: "s1" }),
  ];
  for (const msg of messages) {
    const type = msg.role === "user" ? "user" : "assistant";
    lines.push(
      JSON.stringify({
        type,
        session_id: "s1",
        message: { role: msg.role, content: msg.content },
      }),
    );
  }
  return lines.join("\n");
}

test("returns first real user message, truncated to 60 chars", () => {
  const transcript = makeTranscript([
    { role: "user", content: "Plan checkout flow" },
    { role: "assistant", content: "OK, let me plan that." },
  ]);
  expect(deriveSessionName(transcript)).toBe("Plan checkout flow");
});

test("truncates long messages at 60 chars with ellipsis", () => {
  const longMessage =
    "This is a very long user message that exceeds sixty characters easily";
  const transcript = makeTranscript([{ role: "user", content: longMessage }]);
  const result = deriveSessionName(transcript);
  expect(result).toBe("This is a very long user message that exceeds sixty characte…");
  expect(result!.length).toBe(61);
});

test("skips slash-command messages and returns the first real one", () => {
  const transcript = makeTranscript([
    { role: "user", content: "/trace bind my-task" },
    { role: "user", content: "Now implement the login page" },
  ]);
  expect(deriveSessionName(transcript)).toBe("Now implement the login page");
});

test("skips system-reminder noise and returns the first real message", () => {
  const transcript = makeTranscript([
    {
      role: "user",
      content:
        "<system-reminder>You are working on project X.</system-reminder>",
    },
    { role: "user", content: "Fix the auth bug" },
  ]);
  expect(deriveSessionName(transcript)).toBe("Fix the auth bug");
});

test("surfaces the args of a slash-command invocation, not the command tags", () => {
  const transcript = makeTranscript([
    {
      role: "user",
      content:
        "<command-message>scope</command-message>\n<command-name>/scope</command-name>\n<command-args>Improve the UX of the web platform</command-args>",
    },
  ]);
  expect(deriveSessionName(transcript)).toBe(
    "Improve the UX of the web platform",
  );
});

test("skips a bare slash-command invocation with no args", () => {
  const transcript = makeTranscript([
    {
      role: "user",
      content:
        "<command-message>clear</command-message>\n<command-name>/clear</command-name>\n<command-args></command-args>",
    },
    { role: "user", content: "Build the settings page" },
  ]);
  expect(deriveSessionName(transcript)).toBe("Build the settings page");
});

test("returns null when all user messages are noise", () => {
  const transcript = makeTranscript([
    { role: "user", content: "/implement feature-x" },
    { role: "user", content: "<system-reminder>some reminder</system-reminder>" },
  ]);
  expect(deriveSessionName(transcript)).toBeNull();
});

test("returns null for empty transcript", () => {
  expect(deriveSessionName("")).toBeNull();
});

test("returns null for transcript with no user messages", () => {
  const transcript = makeTranscript([
    { role: "assistant", content: "I'll start working on the task." },
  ]);
  expect(deriveSessionName(transcript)).toBeNull();
});

test("names a Codex session from its first prompt turn", () => {
  const transcript = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started", prompt: "Inspect failing test" }),
    JSON.stringify({ type: "agent_message", message: "On it." }),
    JSON.stringify({ type: "user_message", message: "Run tests" }),
  ].join("\n");
  expect(deriveSessionName(transcript, "codex")).toBe("Inspect failing test");
});

test("resolveSessionName prefers the stored conversation title", () => {
  expect(
    resolveSessionName({
      title: "Refactor the checkout flow",
      transcriptPath: "/tmp/does-not-exist.jsonl",
      tool: "claude",
    }),
  ).toBe("Refactor the checkout flow");
});

test("resolveSessionName falls back to first-line synthesis when title is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-resolve-name-"));
  const transcriptPath = join(dir, "session.jsonl");
  try {
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "system", session_id: "s1" }),
        JSON.stringify({
          type: "user",
          session_id: "s1",
          message: { role: "user", content: "Plan the onboarding flow" },
        }),
      ].join("\n"),
    );

    expect(
      resolveSessionName({ title: null, transcriptPath, tool: "claude" }),
    ).toBe("Plan the onboarding flow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSessionName is null when there is no title and no synthesizable name", () => {
  expect(
    resolveSessionName({
      title: null,
      transcriptPath: "/tmp/does-not-exist.jsonl",
      tool: "claude",
    }),
  ).toBeNull();
});
