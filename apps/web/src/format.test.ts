import { describe, expect, test } from "vitest";
import {
  buildReEnterPrompt,
  collapseHomePath,
  formatContextUsage,
  formatModelName,
  formatRelativeTime,
  formatTokenBreakdown,
  formatTokensCompact,
  resolveDocDisplayTitle,
  truncateId,
  truncatePath,
} from "./format.ts";

describe("formatContextUsage", () => {
  test("renders used / limit with a rounded percent", () => {
    expect(formatContextUsage({ used: 154_826, limit: 300_000 })).toBe(
      "154.8K / 300.0K ctx · 52%",
    );
  });

  test("drops the ratio and percent when the limit is missing", () => {
    expect(formatContextUsage({ used: 154_826, limit: 0 })).toBe("154.8K ctx");
  });
});

describe("formatTokensCompact", () => {
  test("abbreviates millions to one decimal with an M suffix", () => {
    expect(formatTokensCompact(16317514)).toBe("16.3M");
  });

  test("abbreviates thousands to one decimal with a K suffix", () => {
    expect(formatTokensCompact(81123)).toBe("81.1K");
  });

  test("renders zero verbatim", () => {
    expect(formatTokensCompact(0)).toBe("0");
  });

  test("renders counts below 1000 verbatim", () => {
    expect(formatTokensCompact(999)).toBe("999");
  });

  test("renders exactly 1000 as 1.0K", () => {
    expect(formatTokensCompact(1000)).toBe("1.0K");
  });

  test("renders exactly 1,000,000 as 1.0M", () => {
    expect(formatTokensCompact(1_000_000)).toBe("1.0M");
  });

  test("rounds at the one-decimal boundary", () => {
    expect(formatTokensCompact(1549)).toBe("1.5K");
    expect(formatTokensCompact(1551)).toBe("1.6K");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-06-03T12:00:00Z");

  test("reports minutes ago", () => {
    const iso = new Date("2026-06-03T11:57:00Z").toISOString();
    expect(formatRelativeTime(iso, now)).toBe("3m ago");
  });

  test("reports hours ago", () => {
    const iso = new Date("2026-06-03T07:00:00Z").toISOString();
    expect(formatRelativeTime(iso, now)).toBe("5h ago");
  });

  test("reports days ago", () => {
    const iso = new Date("2026-06-01T12:00:00Z").toISOString();
    expect(formatRelativeTime(iso, now)).toBe("2d ago");
  });

  test("reports just now for sub-minute differences", () => {
    const iso = new Date("2026-06-03T11:59:30Z").toISOString();
    expect(formatRelativeTime(iso, now)).toBe("just now");
  });

  test("treats future timestamps as just now", () => {
    const iso = new Date("2026-06-03T12:05:00Z").toISOString();
    expect(formatRelativeTime(iso, now)).toBe("just now");
  });

  test("falls back to a readable absolute date beyond a week", () => {
    const iso = "2026-05-20T12:00:00Z";
    expect(formatRelativeTime(iso, now)).toBe("May 20, 2026");
  });
});

describe("truncateId", () => {
  test("shortens a UUID to its first 8 characters", () => {
    expect(truncateId("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400");
  });

  test("returns non-UUID input unchanged", () => {
    expect(truncateId("checkout-flow")).toBe("checkout-flow");
  });

  test("does not truncate a short non-UUID string", () => {
    expect(truncateId("abc")).toBe("abc");
  });
});

describe("truncatePath", () => {
  test("reduces a posix path to its final segment", () => {
    expect(truncatePath("/tmp/session-1.jsonl")).toBe("session-1.jsonl");
  });

  test("reduces a deep path to its final segment", () => {
    expect(
      truncatePath("/work/trace-v2/docs/web-redesign/web-redesign.tasks.md"),
    ).toBe("web-redesign.tasks.md");
  });

  test("reduces a windows path to its final segment", () => {
    expect(truncatePath("C:\\Users\\foo\\bar.md")).toBe("bar.md");
  });

  test("ignores a trailing separator", () => {
    expect(truncatePath("/a/b/")).toBe("b");
  });

  test("returns a separator-free string unchanged", () => {
    expect(truncatePath("file.md")).toBe("file.md");
  });

  test("returns an empty string unchanged", () => {
    expect(truncatePath("")).toBe("");
  });
});

describe("buildReEnterPrompt", () => {
  test("produces the canonical re-enter prompt string", () => {
    expect(buildReEnterPrompt("Break stop and stale expiry", "break-stop-and-stale-expiry")).toBe(
      'Re-enter the trace task "Break stop and stale expiry" (break-stop-and-stale-expiry)',
    );
  });

  test("preserves special characters in title and slug", () => {
    expect(buildReEnterPrompt("Task: edge-case #1", "task-edge-case-1")).toBe(
      'Re-enter the trace task "Task: edge-case #1" (task-edge-case-1)',
    );
  });
});

describe("collapseHomePath", () => {
  test("replaces a home-directory prefix with ~", () => {
    expect(collapseHomePath("/Users/alice/Projects/trace-v2", "/Users/alice")).toBe(
      "~/Projects/trace-v2",
    );
  });

  test("leaves paths outside home unchanged", () => {
    expect(collapseHomePath("/work/shared/project", "/Users/alice")).toBe(
      "/work/shared/project",
    );
  });

  test("returns home itself as ~", () => {
    expect(collapseHomePath("/Users/alice", "/Users/alice")).toBe("~");
  });
});

describe("resolveDocDisplayTitle", () => {
  test("prefers an explicit title over the filename", () => {
    expect(
      resolveDocDisplayTitle({ path: "/work/docs/plan.md", title: "Launch plan" }),
    ).toBe("Launch plan");
  });

  test("trims a padded explicit title", () => {
    expect(
      resolveDocDisplayTitle({ path: "/work/docs/plan.md", title: "  Launch plan  " }),
    ).toBe("Launch plan");
  });

  test("falls back to the filename when there is no title", () => {
    expect(resolveDocDisplayTitle({ path: "/work/docs/plan.md" })).toBe("plan.md");
  });

  test("falls back to the filename when the title is blank/whitespace", () => {
    expect(
      resolveDocDisplayTitle({ path: "/work/docs/plan.md", title: "   " }),
    ).toBe("plan.md");
  });
});

describe("formatModelName", () => {
  test("formats an opus id with a dotted minor version", () => {
    expect(formatModelName("claude-opus-4-8")).toBe("Opus 4.8");
  });

  test("formats a sonnet id with no minor version", () => {
    expect(formatModelName("claude-sonnet-5")).toBe("Sonnet 5");
  });

  test("strips a trailing release date from a dated haiku variant", () => {
    expect(formatModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  test("formats a codex id readably", () => {
    expect(formatModelName("gpt-5-codex")).toBe("GPT-5 Codex");
  });

  test("formats a bare gpt id with a dotted version", () => {
    expect(formatModelName("gpt-5.5")).toBe("GPT-5.5");
  });

  test("formats a gpt id with a variant suffix", () => {
    expect(formatModelName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  });

  test("formats a composer id with its variant suffix", () => {
    expect(formatModelName("composer-2.5-fast")).toBe("Composer 2.5 Fast");
  });

  test("formats a bare composer id", () => {
    expect(formatModelName("composer-1")).toBe("Composer 1");
  });

  test("falls back to the raw string for an unrecognised id", () => {
    expect(formatModelName("some-unknown-model-id")).toBe("some-unknown-model-id");
  });
});

describe("formatTokenBreakdown", () => {
  test("renders every field as a stable exact-integer line", () => {
    expect(
      formatTokenBreakdown({
        inputTokens: 81123,
        outputTokens: 5,
        cacheCreationInputTokens: 999,
        cacheReadInputTokens: 1_000_000,
        totalTokens: 16_317_514,
      }),
    ).toBe(
      "input 81123 · output 5 · cache read 1000000 · cache write 999 · total 16317514",
    );
  });
});
