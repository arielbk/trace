import { expect, test } from "vitest";
import { parseStateMd } from "./index.ts";

test("parseStateMd extracts a structured handoff state", () => {
  const state = parseStateMd(`# Ready to wire the detail page

## Decisions made

- Keep parsing in **core**.
- Render \`state.md\` inline before sending it to the client.

## Current state

The parser slice is in place.

Downstream slices can consume the returned shape.

## Next step

Add the parsed state to the timeline API.

## Open questions

- Should the panel show ~~stale~~ archived tasks?

---

*Other docs in this task: [plan.md](plan.md)*
`);

  expect(state).toEqual({
    summary: "Ready to wire the detail page",
    decisions: [
      "Keep parsing in <strong>core</strong>.",
      "Render <code>state.md</code> inline before sending it to the client.",
    ],
    currentState: [
      "The parser slice is in place.",
      "Downstream slices can consume the returned shape.",
    ],
    nextStep: "Add the parsed state to the timeline API.",
    openQuestions: [
      "Should the panel show <del>stale</del> archived tasks?",
    ],
  });
});

test("parseStateMd gracefully omits missing sections", () => {
  const state = parseStateMd(`# Partial handoff

## Decisions made

- Use the existing timeline endpoint.

## Next step

Wire the API response into the page.
`);

  expect(state).toEqual({
    summary: "Partial handoff",
    decisions: ["Use the existing timeline endpoint."],
    currentState: [],
    nextStep: "Wire the API response into the page.",
    openQuestions: [],
  });
});

test("parseStateMd falls back to the first line for free-form notes", () => {
  const state = parseStateMd(`Continue from the store tests.

There are no canonical headings yet.
`);

  expect(state).toEqual({
    summary: "Continue from the store tests.",
    decisions: [],
    currentState: [],
    openQuestions: [],
  });
});

test("parseStateMd returns empty collections for empty input", () => {
  expect(parseStateMd(" \n\n ")).toEqual({
    decisions: [],
    currentState: [],
    openQuestions: [],
  });
});

test("parseStateMd renders inline markdown and neutralizes unsafe link protocols", () => {
  const state = parseStateMd(`# Link safety

## Decisions made

- Keep [safe](https://example.com) links.
- Neutralize [bad](javascript:alert(1)) links.
- Neutralize [ftp](ftp://example.com/file) links too.
`);

  expect(state.decisions).toEqual([
    'Keep <a href="https://example.com">safe</a> links.',
    "Neutralize bad links.",
    "Neutralize ftp links too.",
  ]);
});
