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

test("hasProseBody is false for a scaffold that is only its title", () => {
  expect(hasProseBody("# Checkout flow")).toBe(false);
});

test("hasProseBody is true once prose sits below the title", () => {
  expect(hasProseBody("# Checkout flow\n\n## Summary\n\nDid the thing.")).toBe(
    true,
  );
});
