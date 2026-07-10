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
 * Render a session's context-window occupancy (Cursor's snapshot of the live
 * window, not cumulative spend): `{used: 154826, limit: 300000}` →
 * `"154.8K / 300.0K ctx · 52%"`. A missing/zero limit drops the ratio and
 * percent: `"154.8K ctx"`.
 */
export function formatContextUsage(ctx: {
  used: number;
  limit: number;
}): string {
  if (ctx.limit <= 0) return `${formatTokensCompact(ctx.used)} ctx`;
  const percent = Math.round((ctx.used / ctx.limit) * 100);
  return `${formatTokensCompact(ctx.used)} / ${formatTokensCompact(ctx.limit)} ctx · ${percent}%`;
}

/**
 * Render a byte count as a compact file size: `812` → `"812 B"`,
 * `12544` → `"12.3 KB"`, `2_300_000` → `"2.2 MB"`. Sub-kilobyte sizes keep
 * their exact byte count; larger sizes round to one decimal place.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render an ISO timestamp relative to `now`: `"just now"`, `"3m ago"`, `"5h ago"`,
 * `"2d ago"`, falling back to a readable absolute date beyond ~a week.
 */
export function formatRelativeTime(
  iso: string,
  now: Date = new Date(),
): string {
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

type TokenTotalsLike = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

/**
 * One-line exact breakdown of a token-totals object, for hover tooltips on
 * compact counts. Plain integers (no locale separators) so the output is
 * stable across machines.
 */
export function formatTokenBreakdown(totals: TokenTotalsLike): string {
  return [
    `input ${totals.inputTokens}`,
    `output ${totals.outputTokens}`,
    `cache read ${totals.cacheReadInputTokens}`,
    `cache write ${totals.cacheCreationInputTokens}`,
    `total ${totals.totalTokens}`,
  ].join(" · ");
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

/**
 * Browser-safe resolved display title for a doc: explicit `title` (trimmed)
 * when present and non-blank, otherwise the path's filename. This is the
 * client-side branch of the shared `resolveDocTitle` fallback chain — the H1
 * branch is unavailable here because the timeline JSON carries no file content,
 * and the core resolver imports `node:path` so it is not browser-safe. Keep this
 * in step with the floor/whitespace behaviour of `resolveDocTitle`.
 */
export function resolveDocDisplayTitle(doc: {
  path: string;
  title?: string;
}): string {
  const trimmed = doc.title?.trim();
  return trimmed ? trimmed : truncatePath(doc.path);
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

/**
 * Build the canonical re-enter prompt for a task. The slug rides along as
 * the exact resolution hook even though it is not displayed in the UI.
 *
 * Example output: `Re-enter the trace task "Break stop and stale expiry" (break-stop-and-stale-expiry)`
 */
export function buildReEnterPrompt(title: string, slug: string): string {
  return `Re-enter the trace task "${title}" (${slug})`;
}

/**
 * Replace the user's home directory prefix with `~` for compact display.
 * The `home` parameter defaults to `""` — with no home, the path is returned
 * unchanged, so the function is always safe to call. Callers supply the real
 * home directory at runtime (the board fetches it from `/api/config`).
 *
 * Examples:
 *   "/Users/alice/Projects/trace" → "~/Projects/trace"
 *   "/work/shared"               → "/work/shared"
 *   "/Users/alice"               → "~"
 */
export function collapseHomePath(path: string, home: string = ""): string {
  if (!home) return path;
  const normalized = home.replace(/[/\\]+$/, "");
  if (path === normalized) return "~";
  if (path.startsWith(normalized + "/") || path.startsWith(normalized + "\\")) {
    return "~" + path.slice(normalized.length);
  }
  return path;
}

const CLAUDE_MODEL_RE =
  /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*?)(?:-\d{8})?$/;
// OpenAI ids dot the version inline and may trail variant words:
// "gpt-5-codex", "gpt-5.5", "gpt-5.6-sol".
const GPT_MODEL_RE = /^gpt-(\d+(?:[.-]\d+)*)((?:-[a-z]+)*)$/;
// Cursor's in-house models dot the version in the id itself: "composer-2.5-fast".
const COMPOSER_MODEL_RE = /^composer-(\d+(?:\.\d+)*)((?:-[a-z]+)*)$/;

/** `"-codex-mini"` → `"Codex Mini"`; empty for no variant words. */
function titleCaseVariant(variant: string | undefined): string {
  return (variant ?? "")
    .split("-")
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

/**
 * Render a raw model ID readably: `"claude-opus-4-8"` → `"Opus 4.8"`,
 * `"claude-haiku-4-5-20251001"` → `"Haiku 4.5"` (trailing release date
 * dropped), `"gpt-5-codex"` → `"GPT-5 Codex"`, `"gpt-5.6-sol"` →
 * `"GPT-5.6 Sol"`, `"composer-2.5-fast"` → `"Composer 2.5 Fast"`. An
 * unrecognised ID is returned unchanged.
 */
export function formatModelName(id: string): string {
  const claudeMatch = CLAUDE_MODEL_RE.exec(id);
  if (claudeMatch?.[1] && claudeMatch[2]) {
    const family = claudeMatch[1];
    const version = claudeMatch[2];
    return `${family[0]?.toUpperCase()}${family.slice(1)} ${version.replace(/-/g, ".")}`;
  }
  const gptMatch = GPT_MODEL_RE.exec(id);
  if (gptMatch?.[1]) {
    const variant = titleCaseVariant(gptMatch[2]);
    return `GPT-${gptMatch[1].replace(/-/g, ".")}${variant ? ` ${variant}` : ""}`;
  }
  const composerMatch = COMPOSER_MODEL_RE.exec(id);
  if (composerMatch?.[1]) {
    const variant = titleCaseVariant(composerMatch[2]);
    return `Composer ${composerMatch[1]}${variant ? ` ${variant}` : ""}`;
  }
  return id;
}

/** `"May 20, 2026"` — UTC-based so output is stable regardless of machine timezone. */
function formatAbsoluteDate(epochMs: number): string {
  const d = new Date(epochMs);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
