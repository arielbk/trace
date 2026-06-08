import { expect, test } from "vitest";
import { deriveSessionName } from "./session-name.ts";

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
