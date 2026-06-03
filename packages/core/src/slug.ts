const MAX_SLUG_LENGTH = 60;

// Lowercase, transliterate accented latin to ASCII, drop anything that is not a
// letter, digit, or separator, then collapse separators to single dashes. The
// result is a kebab-case handle safe for filesystem paths and URLs.
export function slugify(title: string): string {
  const transliterated = title
    .normalize("NFKD")
    // Strip combining marks left behind by NFKD (accents, diacritics).
    .replace(/[̀-ͯ]/g, "");

  const kebab = transliterated
    .toLowerCase()
    // Anything that is not a lowercase ASCII letter or digit becomes a gap.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return capLength(kebab);
}

// Empty/whitespace-only or fully-stripped titles fall back to a short, stable
// handle derived from the task id, e.g. `task-271d0e57`.
export function generatePlaceholderSlug(id: string): string {
  const shortId = id.split("-")[0] || id;
  return `task-${shortId}`;
}

function capLength(slug: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug;
  }

  const truncated = slug.slice(0, MAX_SLUG_LENGTH);
  const lastDash = truncated.lastIndexOf("-");
  // Prefer cutting at a word boundary so we never emit a half word.
  const trimmed = lastDash > 0 ? truncated.slice(0, lastDash) : truncated;
  return trimmed.replace(/-+$/g, "");
}
