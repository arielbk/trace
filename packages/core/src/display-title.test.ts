import { expect, test } from "vitest";
import { resolveDocTitle } from "./display-title.ts";

test("explicit title wins over H1 and filename", () => {
  const doc = { title: "Explicit Title", path: "/tasks/x/docs/state.md" };
  expect(resolveDocTitle(doc, "# Heading From Content\n\nbody")).toBe(
    "Explicit Title",
  );
});

test("blank/whitespace explicit title falls through to H1", () => {
  const doc = { title: "   ", path: "/tasks/x/docs/plan.md" };
  expect(resolveDocTitle(doc, "# Real Heading")).toBe("Real Heading");
});

test("first H1 is used when there is no explicit title", () => {
  const doc = { path: "/tasks/x/docs/plan.md" };
  expect(resolveDocTitle(doc, "intro line\n# The Plan\n\nmore")).toBe(
    "The Plan",
  );
});

test("falls back to basename when neither title nor H1 present", () => {
  const doc = { path: "/tasks/x/docs/handoff.md" };
  expect(resolveDocTitle(doc, "no heading here\njust body")).toBe(
    "handoff.md",
  );
});

test("falls back to basename when content is absent", () => {
  const doc = { path: "/tasks/x/docs/state.md" };
  expect(resolveDocTitle(doc)).toBe("state.md");
  expect(resolveDocTitle(doc, null)).toBe("state.md");
});

test("ignores ## and deeper headings when finding the H1", () => {
  const doc = { path: "/tasks/x/docs/plan.md" };
  expect(resolveDocTitle(doc, "## Subheading\n\nbody")).toBe("plan.md");
});

test("matches an H1 after leading blank lines and indentation", () => {
  const doc = { path: "/tasks/x/docs/plan.md" };
  expect(resolveDocTitle(doc, "\n\n   # Indented Heading\n")).toBe(
    "Indented Heading",
  );
});

test("requires whitespace after the hash (no `#Heading`)", () => {
  const doc = { path: "/tasks/x/docs/plan.md" };
  expect(resolveDocTitle(doc, "#NoSpace\n")).toBe("plan.md");
});
