import { existsSync, readFileSync, writeFileSync } from "node:fs";

// One rendered row of the docs manifest. `label` is the link text, `href` the
// link target (typically a path relative to state.md), and `description` the
// optional trailing prose.
export type ManifestEntry = {
  label: string;
  href: string;
  description?: string;
};

// Stable HTML-comment markers delimiting the machine-owned manifest region. A
// re-rendered manifest is found and replaced by matching these markers, so they
// must never change once shipped.
const FENCE_START = "<!-- trace:docs-manifest:start -->";
const FENCE_END = "<!-- trace:docs-manifest:end -->";
const MANIFEST_HEADING = "## Docs in this task";

function renderFence(entries: ManifestEntry[]): string {
  const rows = entries.map(
    (entry) =>
      `- [${entry.label}](${entry.href})${
        entry.description ? ` — ${entry.description}` : ""
      }`,
  );
  return [FENCE_START, MANIFEST_HEADING, "", ...rows, "", FENCE_END].join("\n");
}

/**
 * Remove a previously-rendered manifest region (and the `---` divider we
 * inserted just before it) from `content`, returning the prose above it. Prose
 * is left untouched when no fence is present.
 */
export function stripFence(content: string): string {
  const start = content.indexOf(FENCE_START);
  if (start === -1) return content;
  const endMarker = content.indexOf(FENCE_END, start);
  const end = endMarker === -1 ? content.length : endMarker + FENCE_END.length;
  const before = content.slice(0, start);
  const after = content.slice(end);
  // Drop the `---` divider that immediately precedes the fence — it was
  // inserted together with the fence, never authored prose.
  return `${before.replace(/\s*-{3,}\s*$/, "")}${after}`;
}

/**
 * Pure transform: given the existing state.md content and the doc entries,
 * return content carrying the fenced manifest region. Re-rendering replaces the
 * existing fence in place (preserving prose above it and producing byte-
 * identical output when the docs are unchanged) rather than stacking footers.
 * state.md is never listed in its own manifest. The fence sits below a `---`
 * divider so the state parser treats it as a strippable footer and needs no
 * changes.
 */
export function renderManifest(
  content: string,
  entries: ManifestEntry[],
): string {
  const docs = entries.filter((entry) => entry.label !== "state.md");
  const body = stripFence(content).replace(/\s+$/, "");
  return `${body}\n\n---\n\n${renderFence(docs)}\n`;
}

/**
 * Read state.md — scaffolding a minimal `# <title>` document when it does not
 * exist — render the manifest footer from `entries`, and write it back.
 */
export function updateStateManifest(
  stateMdPath: string,
  title: string,
  entries: ManifestEntry[],
): void {
  const present = existsSync(stateMdPath);
  const existing = present ? readFileSync(stateMdPath, "utf8") : `# ${title}\n`;
  const next = renderManifest(existing, entries);
  // Write-if-changed: skip the write (and the mtime bump) when the rendered
  // output already matches what's on disk, so re-running check is a true no-op.
  if (present && existing === next) return;
  writeFileSync(stateMdPath, next);
}
