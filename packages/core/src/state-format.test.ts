import { expect, test } from "vitest";
import { formatStateMd } from "./state-format.ts";
import { parseStateMd } from "./state-parser.ts";
import { hasProseBody } from "./prose-fingerprint.ts";

test("formatStateMd writes a concise summary, current position, and next step", () => {
  const markdown = formatStateMd({
    summary: "Checkout is resumable.",
    currentState: "The parser slice is in place.",
    nextStep: "Add parsed state to the timeline API.",
  });

  expect(markdown).toBe(`# Checkout is resumable.

## Current state

The parser slice is in place.

## Next step

Add parsed state to the timeline API.
`);
});

test("formatStateMd omits empty current-state and next-step sections", () => {
  expect(formatStateMd({ summary: "Nothing left to capture." })).toBe(
    "# Nothing left to capture.\n",
  );
});

test("formatStateMd omits none placeholders instead of stubbing sections", () => {
  expect(
    formatStateMd({
      summary: "Waiting on a decision.",
      currentState: "none",
      nextStep: "N/A",
    }),
  ).toBe("# Waiting on a decision.\n");
});

test("formatStateMd never writes decisions or open-questions sections", () => {
  const markdown = formatStateMd({
    summary: "Ready to ship.",
    currentState: "Tests are green.",
    nextStep: "Tag the release.",
  });

  expect(markdown).not.toMatch(/## Decisions/i);
  expect(markdown).not.toMatch(/## Open questions/i);
});

test("formatStateMd accepts a question as the next step", () => {
  const markdown = formatStateMd({
    summary: "Auth approach is unresolved.",
    currentState: "Both session cookies and JWTs are still on the table.",
    nextStep: "Should the board keep using session cookies?",
  });

  expect(markdown).toContain("## Next step");
  expect(markdown).toContain("Should the board keep using session cookies?");
  expect(markdown).not.toMatch(/## Open questions/i);
});

test("formatStateMd output parses as concise living state", () => {
  const markdown = formatStateMd({
    summary: "Checkout is resumable.",
    currentState: "The parser slice is in place.",
    nextStep: "Add parsed state to the timeline API.",
  });

  expect(parseStateMd(markdown)).toEqual({
    summary: "Checkout is resumable.",
    decisions: [],
    currentState: ["<p>The parser slice is in place.</p>"],
    nextStep: "<p>Add parsed state to the timeline API.</p>",
    openQuestions: [],
  });
});

test("concise formatted state still counts as authored prose for freshness", () => {
  const markdown = formatStateMd({
    summary: "Checkout is resumable.",
    currentState: "The parser slice is in place.",
    nextStep: "Add parsed state to the timeline API.",
  });

  expect(hasProseBody(markdown)).toBe(true);
});
