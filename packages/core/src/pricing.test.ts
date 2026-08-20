import { expect, test } from "vitest";
import { costFromTokenTotals, pricedAt, resolveRate } from "./pricing.ts";
import type { ModelRate } from "./pricing.ts";
import type { TokenTotals } from "./types.ts";

test("resolveRate returns null for an unknown model, not zero or a fallback", () => {
  expect(resolveRate("claude", "not-a-real-model")).toBeNull();
  expect(resolveRate("codex", "codex-auto-review")).toBeNull();
  expect(resolveRate("claude", "<synthetic>")).toBeNull();
  expect(resolveRate("claude", null)).toBeNull();
});

test("resolveRate normalizes dot-vs-dash and date-suffix variants onto one rate", () => {
  const dotted = resolveRate("copilot", "claude-haiku-4.5");
  const dashed = resolveRate("claude", "claude-haiku-4-5");
  const dated = resolveRate("claude", "claude-haiku-4-5-20251001");

  expect(dotted).not.toBeNull();
  expect(dashed).toEqual(dotted);
  expect(dated).toEqual(dotted);
});

test("resolveRate applies the 2× cache-write override, not upstream's 1.25×", () => {
  for (const model of [
    "claude-haiku-4.5",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
  ]) {
    const resolved = resolveRate("claude", model);
    expect(resolved, model).not.toBeNull();
    expect(resolved?.cacheWriteUsdPerMillion).toBe(
      2 * resolved!.inputUsdPerMillion,
    );
    expect(resolved?.cacheWriteUsdPerMillion).not.toBe(
      1.25 * resolved!.inputUsdPerMillion,
    );
  }
});

const millionEach: TokenTotals = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheCreationInputTokens: 1_000_000,
  cacheReadInputTokens: 1_000_000,
  totalTokens: 4_000_000,
};

const rate: ModelRate = {
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  cacheWriteUsdPerMillion: 4,
  cacheReadUsdPerMillion: 0.1,
};

test("costFromTokenTotals prices all four token buckets", () => {
  expect(costFromTokenTotals(millionEach, rate)).toBe(7.1);
});

test("resolveRate does not fall back to a prefix match", () => {
  expect(resolveRate("cursor", "claude-opus-4-8-thinking-high")).toBeNull();
});

test("the pinned table carries a pricedAt identifier", () => {
  expect(pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("resolveRate returns a rate for each observed model family", () => {
  const observed: Array<Parameters<typeof resolveRate>> = [
    ["claude", "claude-opus-4-8"],
    ["claude", "claude-opus-5"],
    ["claude", "claude-fable-5"],
    ["claude", "claude-opus-4-7"],
    ["claude", "claude-haiku-4-5-20251001"],
    ["claude", "claude-sonnet-5"],
    ["claude", "claude-sonnet-4-6"],
    ["codex", "gpt-5.5"],
    ["codex", "gpt-5.6-sol"],
    ["codex", "gpt-5.6-terra"],
    ["codex", "gpt-5.2-codex"],
    ["codex", "gpt-5.1-codex-max"],
    ["codex", "gpt-5.4"],
    ["codex", "gpt-5-codex"],
    ["codex", "gpt-5.3-codex"],
    ["codex", "gpt-5.6"],
    ["copilot", "gpt-5-mini"],
  ];

  for (const [tool, model] of observed) {
    const resolved = resolveRate(tool, model);
    expect(resolved, model ?? "").not.toBeNull();
    expect(resolved?.inputUsdPerMillion).toBeGreaterThan(0);
    expect(resolved?.outputUsdPerMillion).toBeGreaterThan(0);
  }
});
