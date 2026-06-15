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
 * Pure transform: given the existing state.md content and the doc entries,
 * return content carrying the fenced manifest region. The fence sits below a
 * `---` divider so the state parser treats it as a strippable footer and needs
 * no changes.
 */
export function renderManifest(
  content: string,
  entries: ManifestEntry[],
): string {
  const body = content.replace(/\s+$/, "");
  return `${body}\n\n---\n\n${renderFence(entries)}\n`;
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
  const existing = existsSync(stateMdPath)
    ? readFileSync(stateMdPath, "utf8")
    : `# ${title}\n`;
  writeFileSync(stateMdPath, renderManifest(existing, entries));
}
