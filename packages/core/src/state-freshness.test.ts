import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { computeStateFreshness } from "./state-freshness.ts";
import {
  reconcileStateDocumentManifest,
  stampStateDocumentProse,
  stateDocumentPath,
} from "./state-document.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-freshness-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const specEntry = { label: "spec.md", href: "spec.md" };

function writeSpec(body: string): { path: string } {
  const path = join(dir, "spec.md");
  writeFileSync(path, body);
  return { path };
}

/** Seed a State Document whose prose reflects the current docs. */
function seedReflectedState(docs: { path: string }[], prose: string): void {
  writeFileSync(stateDocumentPath(dir), prose);
  const fingerprint = computeStateFreshness(dir, docs).fingerprint;
  stampStateDocumentProse(dir, "Checkout", [specEntry], {
    fingerprint,
    writtenAt: "2026-08-22T09:00:00.000Z",
  });
}

test("a task with no content doc abstains — there is nothing to reflect on", () => {
  const verdict = computeStateFreshness(dir, []);

  expect(verdict.needsProsePass).toBeUndefined();
  expect(verdict.mode).toBeUndefined();
  expect(verdict.stateExists).toBe(false);
});

test("a missing State Document needs seeding", () => {
  const spec = writeSpec("# Spec\n");

  const verdict = computeStateFreshness(dir, [spec]);

  expect(verdict.stateExists).toBe(false);
  expect(verdict.needsProsePass).toBe(true);
  expect(verdict.mode).toBe("seed");
});

test("a scaffold with only its title needs seeding", () => {
  const spec = writeSpec("# Spec\n");
  reconcileStateDocumentManifest(dir, "Checkout", [specEntry]);

  const verdict = computeStateFreshness(dir, [spec, { path: stateDocumentPath(dir) }]);

  expect(verdict.stateExists).toBe(true);
  expect(verdict.needsProsePass).toBe(true);
  expect(verdict.mode).toBe("seed");
});

test("prose stamped against the current docs is fresh", () => {
  const spec = writeSpec("# Spec\n");
  const docs = [spec, { path: stateDocumentPath(dir) }];
  seedReflectedState(docs, "# Halfway\n\nProse.\n");

  const verdict = computeStateFreshness(dir, docs);

  expect(verdict.needsProsePass).toBe(false);
  expect(verdict.mode).toBeUndefined();
  expect(verdict.stamp?.writtenAt).toBe("2026-08-22T09:00:00.000Z");
});

test("editing a doc drifts the prose into refresh", () => {
  const spec = writeSpec("# Spec\n");
  const docs = [spec, { path: stateDocumentPath(dir) }];
  seedReflectedState(docs, "# Halfway\n\nProse.\n");

  writeFileSync(spec.path, "# Spec\n\nNow with a body.\n");
  const verdict = computeStateFreshness(dir, docs);

  expect(verdict.needsProsePass).toBe(true);
  expect(verdict.mode).toBe("refresh");
  expect(verdict.changedDocs).toEqual(["spec.md"]);
});

test("rewriting the State Document alone never drifts the prose", () => {
  const spec = writeSpec("# Spec\n");
  const docs = [spec, { path: stateDocumentPath(dir) }];
  seedReflectedState(docs, "# Halfway\n\nProse.\n");
  const before = computeStateFreshness(dir, docs).fingerprint;

  // A footer reconcile touches state.md and nothing else.
  reconcileStateDocumentManifest(dir, "Checkout", [
    specEntry,
    { label: "plan.md", href: "plan.md" },
  ]);
  const verdict = computeStateFreshness(dir, docs);

  expect(verdict.fingerprint).toBe(before);
  expect(verdict.needsProsePass).toBe(false);
});

test("a garbled stamp counts as drift", () => {
  const spec = writeSpec("# Spec\n");
  const docs = [spec, { path: stateDocumentPath(dir) }];
  seedReflectedState(docs, "# Halfway\n\nProse.\n");

  writeFileSync(
    stateDocumentPath(dir),
    "# Halfway\n\nProse.\n\n<!-- trace:prose-fingerprint:NOTHEX -->\n",
  );
  const verdict = computeStateFreshness(dir, docs);

  expect(verdict.needsProsePass).toBe(true);
  expect(verdict.mode).toBe("refresh");
});

test("a legacy stamp still matches when the docs have not moved", () => {
  const spec = writeSpec("# Spec\n");
  const docs = [spec, { path: stateDocumentPath(dir) }];
  const fingerprint = computeStateFreshness(dir, docs).fingerprint;
  writeFileSync(
    stateDocumentPath(dir),
    `# Halfway\n\nProse.\n\n<!-- trace:prose-fingerprint:${fingerprint} -->\n`,
  );

  const verdict = computeStateFreshness(dir, docs);

  expect(verdict.needsProsePass).toBe(false);
  expect(verdict.stamp).toEqual({ fingerprint });
  expect(verdict.stamp?.writtenAt).toBeUndefined();
});

test("an unreadable doc hashes as empty rather than throwing", () => {
  const verdict = computeStateFreshness(dir, [{ path: join(dir, "gone.md") }]);

  expect(verdict.fingerprint).toHaveLength(64);
  expect(verdict.needsProsePass).toBe(true);
});
