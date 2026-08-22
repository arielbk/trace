import { createHash } from "node:crypto";

/**
 * The machine-owned prose stamp: what the last prose pass reflected, and when
 * it ran. `state reflect` writes it; `state check` compares the fingerprint to
 * decide whether the prose has drifted, and the board reads `writtenAt` to say
 * how old the prose is.
 *
 * `writtenAt` is why the stamp exists rather than a bare hash. `state.md` is
 * machine-maintained — every bind and every doc retitle rewrites its manifest
 * footer — so the file's mtime answers "when was this file last touched", not
 * "when was this prose last written". The stamp answers the second question,
 * and it travels with the file through doc sync.
 */
export type ProseStamp = {
  fingerprint: string;
  /** ISO-8601 instant the prose was written; absent on pre-timestamp stamps. */
  writtenAt?: string;
};

// The marker's two shipped shapes: `:HASH` alone (written before stamps carried
// a time) and `:HASH:ISO8601`. Both must keep parsing forever — a State
// Document written by an older Trace is still a valid State Document.
const PROSE_MARKER_RE =
  /<!--\s*trace:prose-fingerprint:([0-9a-f]+)(?::(\S+?))?\s*-->/;
const PROSE_MARKER_RE_GLOBAL = new RegExp(PROSE_MARKER_RE.source, "g");

export function renderProseMarker(stamp: ProseStamp | string): string {
  const { fingerprint, writtenAt } =
    typeof stamp === "string" ? { fingerprint: stamp, writtenAt: undefined } : stamp;
  const suffix = writtenAt ? `:${writtenAt}` : "";
  return `<!-- trace:prose-fingerprint:${fingerprint}${suffix} -->`;
}

/**
 * Read the stamp a prior prose pass left. Returns null when the marker is
 * absent or garbled (no valid hex hash) — both resolve to drift at the call
 * site. A legacy marker parses with no `writtenAt`.
 */
export function readProseStamp(content: string): ProseStamp | null {
  const match = content.match(PROSE_MARKER_RE);
  const fingerprint = match?.[1];
  if (!fingerprint) return null;
  const writtenAt = match[2];
  return writtenAt ? { fingerprint, writtenAt } : { fingerprint };
}

/** The fingerprint alone, for callers that only compare drift. */
export function readProseFingerprint(content: string): string | null {
  return readProseStamp(content)?.fingerprint ?? null;
}

/** Remove every prose marker, so a fresh one can be stamped in its place. */
export function stripProseMarkers(content: string): string {
  return content.replace(PROSE_MARKER_RE_GLOBAL, "");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type DocFingerprintInput = { path: string; content: string };

/**
 * Fingerprint over the sorted set of doc relative paths, each combined with a
 * hash of its contents. Sorting makes the result independent of doc ordering.
 *
 * Callers pass the task's docs *excluding* the State Document — its own churn
 * must never invalidate the prose stamped inside it. `state-freshness.ts` owns
 * that split, so this module stays a leaf with no opinion about which doc is
 * which.
 */
export function computeDocsFingerprint(docs: DocFingerprintInput[]): string {
  const entries = docs
    .map((doc) => `${doc.path} ${sha256(doc.content)}`)
    .sort();
  return sha256(entries.join("\n"));
}

// True when state.md carries authored prose beyond the scaffold `# title` line.
// Takes the prose region (fence and stamp already stripped by the State
// Document module), so a freshly-seeded scaffold reads as empty.
export function hasProseBody(prose: string): boolean {
  const withoutTitle = prose.trim().replace(/^#\s+[^\n]*\n?/, "").trim();
  return withoutTitle.length > 0;
}
