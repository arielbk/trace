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

// Strict UUID shape, as produced by randomUUID for task ids. Slugs that read
// as UUIDs are rejected at allocation: getTaskByRef resolves ids before
// slugs, so such a slug could silently shadow (or be shadowed by) another
// task's id.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function looksLikeTaskId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

// Kebab-case shape with at least one dash, e.g. `break-stop-and-stale-expiry`.
// Single lowercase words ("checkout") are ordinary titles, not slugs. UUIDs
// are kebab-shaped hex but keep their own placeholder handling, so they are
// excluded here.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

export function looksLikeSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && !looksLikeTaskId(value);
}

// Turn a slug back into a readable title: dashes become spaces and the first
// letter is capitalized, e.g. `break-stop-and-stale-expiry` reads as
// "Break stop and stale expiry".
export function humanizeSlug(slug: string): string {
  const spaced = slug.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
