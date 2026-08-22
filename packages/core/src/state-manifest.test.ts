import { expect, test } from "vitest";
import { parseStateMd } from "./state-parser.ts";
import { renderManifest } from "./state-manifest.ts";

test("renderManifest appends a fenced footer below a divider", () => {
  const out = renderManifest("# Checkout\n", [
    { label: "spec.md", href: "spec.md", description: "The spec" },
  ]);

  expect(out).toContain("<!-- trace:docs-manifest:start -->");
  expect(out).toContain("<!-- trace:docs-manifest:end -->");
  expect(out).toContain("- [spec.md](spec.md) — The spec");
  // The fence lives below the `---` divider so the state parser strips it.
  expect(out.indexOf("---")).toBeLessThan(
    out.indexOf("<!-- trace:docs-manifest:start -->"),
  );
});

test("the rendered fence is treated as a strippable footer by the state parser", () => {
  const out = renderManifest("# Checkout\n", [
    { label: "spec.md", href: "spec.md", description: "The spec" },
  ]);

  const parsed = parseStateMd(out);
  expect(parsed.summary).toBe("Checkout");
  expect(parsed.decisions).toEqual([]);
});

test("renderManifest replaces an existing fenced region, preserving prose above", () => {
  const first = renderManifest("# Checkout\n\n## Summary\n\nDid the thing.\n", [
    { label: "spec.md", href: "spec.md", description: "The spec" },
  ]);

  const second = renderManifest(first, [
    { label: "plan.md", href: "plan.md", description: "The plan" },
  ]);

  // Prose above the fence survives.
  expect(second).toContain("## Summary");
  expect(second).toContain("Did the thing.");
  // The new doc is listed, the stale one is gone.
  expect(second).toContain("- [plan.md](plan.md) — The plan");
  expect(second).not.toContain("spec.md");
  // Exactly one fenced region — no duplicate footers stacked up.
  expect(second.match(/trace:docs-manifest:start/g)).toHaveLength(1);
});

test("renderManifest is idempotent when the docs are unchanged", () => {
  const entries = [
    { label: "spec.md", href: "spec.md", description: "The spec" },
  ];
  const once = renderManifest("# Checkout\n\n## Summary\n\nProse.\n", entries);
  const twice = renderManifest(once, entries);

  expect(twice).toBe(once);
});

test("renderManifest lists multiple docs", () => {
  const out = renderManifest("# Checkout\n", [
    { label: "spec.md", href: "spec.md", description: "The spec" },
    { label: "plan.md", href: "plan.md", description: "The plan" },
  ]);

  expect(out).toContain("- [spec.md](spec.md) — The spec");
  expect(out).toContain("- [plan.md](plan.md) — The plan");
});

test("renderManifest renders a bare link when a doc has no description", () => {
  const out = renderManifest("# Checkout\n", [
    { label: "notes.md", href: "notes.md" },
  ]);

  expect(out).toContain("- [notes.md](notes.md)");
  expect(out).not.toContain("notes.md) —");
});

test("renderManifest inserts a fence on a state.md that lacks one", () => {
  const out = renderManifest("# Checkout\n\n## Summary\n\nProse only.\n", [
    { label: "spec.md", href: "spec.md", description: "The spec" },
  ]);

  expect(out).toContain("## Summary");
  expect(out).toContain("Prose only.");
  expect(out.match(/trace:docs-manifest:start/g)).toHaveLength(1);
});
