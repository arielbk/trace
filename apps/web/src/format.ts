/**
 * Pure formatting utilities shared by the web pages and the copy-chip component.
 * No DOM or React dependencies — keep this module trivially unit-testable.
 */

/** Abbreviate a token count: `16317514` → `"16.3M"`, `81123` → `"81.1K"`, `<1000` verbatim. */
export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Render an ISO timestamp relative to `now`: `"just now"`, `"3m ago"`, `"5h ago"`,
 * `"2d ago"`, falling back to a readable absolute date beyond ~a week.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatAbsoluteDate(then);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shorten a UUID to its first 8 characters for compact display. Non-UUID
 * input (e.g. a human-authored title) is returned unchanged.
 */
export function truncateId(id: string): string {
  return UUID_RE.test(id) ? id.slice(0, 8) : id;
}

/**
 * Reduce a file path to its tail (final segment) for compact display, e.g.
 * `"/tmp/session-1.jsonl"` → `"session-1.jsonl"`. Handles both posix (`/`) and
 * windows (`\`) separators and ignores a trailing separator. A string with no
 * separator (or an empty string) is returned unchanged. Callers should pass the
 * full path separately as the copyable value (see `CopyChip`).
 */
export function truncatePath(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `"May 20, 2026"` — UTC-based so output is stable regardless of machine timezone. */
function formatAbsoluteDate(epochMs: number): string {
  const d = new Date(epochMs);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
