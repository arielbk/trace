import { basename } from "node:path";

// The minimal doc shape the resolver reads — every surface (manifest, viewer,
// timeline) holds at least a path and an optional explicit title.
export type ResolvableDoc = {
  path: string;
  title?: string;
};

/**
 * The single place a doc's display title is resolved: an explicit title wins,
 * else the first `# ` H1 in the content, else the filename. The manifest,
 * doc-viewer header, and timeline row all resolve titles through here so the
 * fallback chain is never duplicated. `content` is optional — pass `null`/
 * `undefined` when the file body isn't available and resolution falls straight
 * through to the filename.
 */
export function resolveDocTitle(
  doc: ResolvableDoc,
  content?: string | null,
): string {
  const explicit = doc.title?.trim();
  if (explicit) return explicit;

  const h1 = content != null ? firstH1(content) : null;
  if (h1) return h1;

  return basename(doc.path);
}

/**
 * Find the first ATX H1 (`# Heading`). Up to three leading spaces are allowed
 * (CommonMark), exactly one `#` must be followed by whitespace — `##` and
 * deeper headings are not matched.
 */
function firstH1(content: string): string | null {
  for (const line of content.split("\n")) {
    const match = line.match(/^ {0,3}#[ \t]+(.+?)[ \t]*$/);
    if (match) return match[1] ?? null;
  }
  return null;
}
