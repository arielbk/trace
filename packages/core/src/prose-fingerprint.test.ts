import { expect, test } from "vitest";
import {
  computeDocsFingerprint,
  hasProseBody,
  readProseFingerprint,
  renderProseMarker,
} from "./prose-fingerprint.ts";

test("fingerprint is stable across doc reorderings", () => {
  const a = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
    { path: "plan.md", content: "Plan body" },
  ]);
  const b = computeDocsFingerprint([
    { path: "plan.md", content: "Plan body" },
    { path: "spec.md", content: "Spec body" },
  ]);

  expect(a).toBe(b);
});

test("fingerprint changes when a doc is added", () => {
  const before = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
  ]);
  const after = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
    { path: "plan.md", content: "Plan body" },
  ]);

  expect(after).not.toBe(before);
});

test("fingerprint changes when a doc is removed", () => {
  const before = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
    { path: "plan.md", content: "Plan body" },
  ]);
  const after = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
  ]);

  expect(after).not.toBe(before);
});

test("fingerprint changes when a doc is edited in place", () => {
  const before = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
  ]);
  const after = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body, revised" },
  ]);

  expect(after).not.toBe(before);
});

test("fingerprint excludes state.md", () => {
  const withState = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
    { path: "state.md", content: "# Title\n\nliving state" },
  ]);
  const withoutState = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
  ]);

  expect(withState).toBe(withoutState);
});

test("fingerprint excludes a nested state.md by basename", () => {
  const withState = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
    { path: "docs/state.md", content: "living state" },
  ]);
  const withoutState = computeDocsFingerprint([
    { path: "spec.md", content: "Spec body" },
  ]);

  expect(withState).toBe(withoutState);
});

test("readProseFingerprint round-trips a rendered marker", () => {
  const marker = renderProseMarker("abc123");
  expect(readProseFingerprint(`# Title\n\n${marker}\n`)).toBe("abc123");
});

test("readProseFingerprint returns null on a missing marker", () => {
  expect(readProseFingerprint("# Title\n\nno marker here")).toBeNull();
});

test("readProseFingerprint returns null on a garbled marker", () => {
  expect(readProseFingerprint("<!-- trace:prose-fingerprint: -->")).toBeNull();
});

test("hasProseBody is false for a bare scaffold title", () => {
  expect(hasProseBody("# Checkout flow\n")).toBe(false);
});

test("hasProseBody is false for a scaffold title plus only a docs fence", () => {
  const scaffold =
    "# Checkout flow\n\n---\n\n<!-- trace:docs-manifest:start -->\n## Docs in this task\n\n- [spec.md](spec.md)\n\n<!-- trace:docs-manifest:end -->\n";
  expect(hasProseBody(scaffold)).toBe(false);
});

test("hasProseBody is true once prose sits above the fence", () => {
  const withProse =
    "# Checkout flow\n\n## Summary\n\nDid the thing.\n\n---\n\n<!-- trace:docs-manifest:start -->\n## Docs in this task\n\n- [spec.md](spec.md)\n\n<!-- trace:docs-manifest:end -->\n";
  expect(hasProseBody(withProse)).toBe(true);
});
