import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  readProseStamp,
  renderProseMarker,
  stripProseMarkers,
  type ProseStamp,
} from "./prose-fingerprint.ts";
import {
  renderManifest,
  stripFence,
  type ManifestEntry,
} from "./state-manifest.ts";

/**
 * The State Document — the living `state.md` in a task's docs dir.
 *
 * This module owns the artifact end to end: its filename, the three regions it
 * is made of (authored prose, the machine-owned prose stamp, the machine-owned
 * docs-manifest fence), and the read → mutate one region → write-if-changed
 * cycle. Callers name the region they want to change; they never reconstruct
 * the path, re-declare the "is this the state doc?" predicate, or hand-assemble
 * the divider and markers.
 */

export const STATE_DOCUMENT_FILENAME = "state.md";

/** True when `path` points at a task's State Document. */
export function isStateDocument(path: string): boolean {
  return basename(path) === STATE_DOCUMENT_FILENAME;
}

/** Where the State Document lives for a task whose docs sit in `docsDir`. */
export function stateDocumentPath(docsDir: string): string {
  return join(docsDir, STATE_DOCUMENT_FILENAME);
}

/**
 * Split a task's docs into the State Document and everything else. Every
 * fingerprint, manifest, and timeline caller wants exactly this split, and
 * spelling it as a `basename(...) !== "state.md"` filter is how the filename
 * leaked into nine call sites.
 */
export function partitionStateDocument<T extends { path: string }>(
  docs: readonly T[],
): { state: T | undefined; others: T[] } {
  return {
    state: docs.find((doc) => isStateDocument(doc.path)),
    others: docs.filter((doc) => !isStateDocument(doc.path)),
  };
}

/** A State Document read off disk, split into its named regions. */
export type StateDocument = {
  /** Absolute path to `state.md`, whether or not it exists yet. */
  path: string;
  /** False when nothing is on disk — `raw` then holds the scaffold. */
  exists: boolean;
  /** Full file contents (or the scaffold when absent), exactly as written. */
  raw: string;
  /** Authored prose with the stamp and the docs fence removed. */
  prose: string;
  /** The stamp a prior prose pass left, or null when absent/garbled. */
  stamp: ProseStamp | null;
};

/**
 * Read the State Document for `docsDir`. When the file is absent, the returned
 * document carries a minimal `# <title>` scaffold as its prose so callers can
 * render a complete file without knowing the scaffold's shape.
 */
export function readStateDocument(
  docsDir: string,
  titleFallback: string,
): StateDocument {
  const path = stateDocumentPath(docsDir);
  const exists = existsSync(path);
  const raw = exists ? readFileSync(path, "utf8") : `# ${titleFallback}\n`;
  return {
    path,
    exists,
    raw,
    prose: extractProse(raw),
    stamp: readProseStamp(raw),
  };
}

/** Isolate the authored prose: drop the docs fence, then any prose stamp. */
function extractProse(raw: string): string {
  return stripProseMarkers(stripFence(raw)).replace(/\s+$/, "");
}

/**
 * Assemble a complete State Document from its regions: prose, then the stamp
 * (when one is being carried or written), then the docs-manifest fence below a
 * `---` divider.
 */
export function renderStateDocument(input: {
  prose: string;
  stamp?: ProseStamp | null;
  entries: readonly ManifestEntry[];
}): string {
  const prose = input.prose.replace(/\s+$/, "");
  const body = input.stamp
    ? `${prose}\n\n${renderProseMarker(input.stamp)}`
    : prose;
  // The State Document is never listed in its own manifest.
  const docs = input.entries.filter((entry) => !isStateDocument(entry.href));
  return renderManifest(body, docs);
}

/**
 * Write `content` to the State Document, skipping the write — and the mtime
 * bump with it — when the bytes already match. Returns true when the file
 * changed on disk.
 *
 * The mtime matters beyond IO cost: it is what the board falls back to for
 * State Documents written before stamps carried a timestamp, so a no-op
 * reconcile must stay a true no-op.
 */
export function writeStateDocument(
  document: StateDocument,
  content: string,
): boolean {
  if (document.exists && document.raw === content) return false;
  mkdirSync(dirname(document.path), { recursive: true });
  writeFileSync(document.path, content);
  return true;
}

/**
 * Re-render the docs-manifest fence from `entries`, leaving the prose and the
 * prose stamp exactly as they were. This is the bookkeeping write every bind
 * seam and `trace state check` makes.
 */
export function reconcileStateDocumentManifest(
  docsDir: string,
  titleFallback: string,
  entries: readonly ManifestEntry[],
): boolean {
  const document = readStateDocument(docsDir, titleFallback);
  return writeStateDocument(
    document,
    renderStateDocument({
      prose: document.prose,
      stamp: document.stamp,
      entries,
    }),
  );
}

/**
 * Stamp the State Document: record that the prose on disk now reflects
 * `stamp.fingerprint`, written at `stamp.writtenAt`. Only `trace state reflect`
 * calls this — it is the one seam that means "the prose was just written",
 * which is exactly why the timestamp is trustworthy where the file's mtime is
 * not.
 *
 * Unlike the manifest reconcile, this always writes: `writtenAt` moves on every
 * call by design. Nothing reflects speculatively — no hook or bind seam reaches
 * this function — so a call is proof a prose pass just happened.
 */
export function stampStateDocumentProse(
  docsDir: string,
  titleFallback: string,
  entries: readonly ManifestEntry[],
  stamp: ProseStamp,
): boolean {
  const document = readStateDocument(docsDir, titleFallback);
  return writeStateDocument(
    document,
    renderStateDocument({ prose: document.prose, stamp, entries }),
  );
}
