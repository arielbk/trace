import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseStateMd } from "./state-parser.ts";
import { renderManifest, updateStateManifest } from "./state-manifest.ts";

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

test("updateStateManifest creates a minimal state.md when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-manifest-"));
  const statePath = join(dir, "state.md");

  try {
    updateStateManifest(statePath, "Checkout flow", [
      { label: "spec.md", href: "spec.md", description: "The spec" },
    ]);

    const written = readFileSync(statePath, "utf8");
    expect(written).toContain("# Checkout flow");
    expect(written).toContain("- [spec.md](spec.md) — The spec");
    // No empty prose headings in the minimal scaffold.
    expect(written).not.toContain("## Decisions");
    expect(written).not.toContain("## Next step");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
