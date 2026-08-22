import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  isStateDocument,
  partitionStateDocument,
  readStateDocument,
  reconcileStateDocumentManifest,
  renderStateDocument,
  stampStateDocumentProse,
  stateDocumentPath,
} from "./state-document.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-state-doc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const specEntry = {
  label: "spec.md",
  href: "spec.md",
  description: "The spec",
};

function pinMtimeToThePast(path: string): number {
  const past = new Date("2020-01-01T00:00:00Z");
  utimesSync(path, past, past);
  return statSync(path).mtimeMs;
}

test("isStateDocument recognises the state file by any path shape", () => {
  expect(isStateDocument("state.md")).toBe(true);
  expect(isStateDocument("/tmp/task/docs/state.md")).toBe(true);
  expect(isStateDocument("/tmp/task/docs/spec.md")).toBe(false);
  expect(isStateDocument("/tmp/task/docs/my-state.md")).toBe(false);
});

test("partitionStateDocument splits the state file from the content docs", () => {
  const docs = [
    { path: "/docs/spec.md" },
    { path: "/docs/state.md" },
    { path: "/docs/plan.md" },
  ];

  const { state, others } = partitionStateDocument(docs);

  expect(state?.path).toBe("/docs/state.md");
  expect(others.map((doc) => doc.path)).toEqual([
    "/docs/spec.md",
    "/docs/plan.md",
  ]);
});

test("readStateDocument scaffolds a title when nothing is on disk", () => {
  const document = readStateDocument(dir, "Checkout flow");

  expect(document.exists).toBe(false);
  expect(document.path).toBe(stateDocumentPath(dir));
  expect(document.prose).toBe("# Checkout flow");
  expect(document.stamp).toBeNull();
});

test("readStateDocument splits prose, stamp, and fence apart", () => {
  reconcileStateDocumentManifest(dir, "Checkout flow", [specEntry]);
  stampStateDocumentProse(dir, "Checkout flow", [specEntry], {
    fingerprint: "abc123",
    writtenAt: "2026-08-22T09:00:00.000Z",
  });

  const document = readStateDocument(dir, "Checkout flow");

  expect(document.exists).toBe(true);
  expect(document.prose).toBe("# Checkout flow");
  expect(document.prose).not.toContain("trace:");
  expect(document.stamp).toEqual({
    fingerprint: "abc123",
    writtenAt: "2026-08-22T09:00:00.000Z",
  });
});

test("renderStateDocument keeps the State Document out of its own manifest", () => {
  const out = renderStateDocument({
    prose: "# Checkout flow",
    entries: [
      { label: "Living state", href: "state.md" },
      specEntry,
    ],
  });

  expect(out).toContain("- [spec.md](spec.md) — The spec");
  expect(out).not.toContain("(state.md)");
});

test("reconcileStateDocumentManifest creates a minimal file when absent", () => {
  reconcileStateDocumentManifest(dir, "Checkout flow", [specEntry]);

  const written = readFileSync(stateDocumentPath(dir), "utf8");
  expect(written).toContain("# Checkout flow");
  expect(written).toContain("- [spec.md](spec.md) — The spec");
  // No empty prose headings in the minimal scaffold.
  expect(written).not.toContain("## Decisions");
  expect(written).not.toContain("## Next step");
});

test("reconcileStateDocumentManifest does not rewrite unchanged content", () => {
  reconcileStateDocumentManifest(dir, "Checkout flow", [specEntry]);
  const before = pinMtimeToThePast(stateDocumentPath(dir));

  const wrote = reconcileStateDocumentManifest(dir, "Checkout flow", [
    specEntry,
  ]);

  expect(wrote).toBe(false);
  expect(statSync(stateDocumentPath(dir)).mtimeMs).toBe(before);
});

test("reconcileStateDocumentManifest preserves the prose and its stamp", () => {
  writeFileSync(
    stateDocumentPath(dir),
    "# Halfway there\n\nWe shipped the parser.\n",
  );
  stampStateDocumentProse(dir, "Checkout flow", [specEntry], {
    fingerprint: "abc123",
    writtenAt: "2026-08-22T09:00:00.000Z",
  });

  reconcileStateDocumentManifest(dir, "Checkout flow", [
    specEntry,
    { label: "plan.md", href: "plan.md" },
  ]);

  const document = readStateDocument(dir, "Checkout flow");
  expect(document.prose).toContain("We shipped the parser.");
  expect(document.stamp).toEqual({
    fingerprint: "abc123",
    writtenAt: "2026-08-22T09:00:00.000Z",
  });
  expect(document.raw).toContain("- [plan.md](plan.md)");
});

test("stampStateDocumentProse records when the prose was written", () => {
  writeFileSync(stateDocumentPath(dir), "# Halfway there\n\nProse.\n");

  stampStateDocumentProse(dir, "Checkout flow", [specEntry], {
    fingerprint: "abc123",
    writtenAt: "2026-08-22T09:00:00.000Z",
  });

  const raw = readFileSync(stateDocumentPath(dir), "utf8");
  expect(raw).toContain(
    "<!-- trace:prose-fingerprint:abc123:2026-08-22T09:00:00.000Z -->",
  );
  // Exactly one marker — a re-stamp replaces rather than stacks.
  expect(raw.match(/trace:prose-fingerprint/g)).toHaveLength(1);
});

test("re-stamping moves the recorded write time", () => {
  writeFileSync(stateDocumentPath(dir), "# Halfway there\n\nProse.\n");
  stampStateDocumentProse(dir, "Checkout flow", [specEntry], {
    fingerprint: "abc123",
    writtenAt: "2026-08-22T09:00:00.000Z",
  });

  const wrote = stampStateDocumentProse(dir, "Checkout flow", [specEntry], {
    fingerprint: "abc123",
    writtenAt: "2026-08-22T18:00:00.000Z",
  });

  expect(wrote).toBe(true);
  expect(readStateDocument(dir, "Checkout flow").stamp?.writtenAt).toBe(
    "2026-08-22T18:00:00.000Z",
  );
});

test("stamping over a legacy marker adopts the timestamped shape", () => {
  writeFileSync(
    stateDocumentPath(dir),
    "# Halfway there\n\nProse.\n\n<!-- trace:prose-fingerprint:abc123 -->\n",
  );

  stampStateDocumentProse(dir, "Checkout flow", [specEntry], {
    fingerprint: "def456",
    writtenAt: "2026-08-22T18:00:00.000Z",
  });

  expect(readStateDocument(dir, "Checkout flow").stamp).toEqual({
    fingerprint: "def456",
    writtenAt: "2026-08-22T18:00:00.000Z",
  });
});
