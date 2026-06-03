import { describe, expect, test } from "vitest";
import {
  formatRelativeTime,
  formatTokensCompact,
  truncateId,
  truncatePath,
} from "./format.ts";

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
