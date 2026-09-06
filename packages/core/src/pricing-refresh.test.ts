import { expect, test } from "vitest";
import { buildPricingSnapshot } from "./pricing-refresh.ts";
import pinned from "./pricing-table.json" with { type: "json" };

test("buildPricingSnapshot applies the 2× Anthropic cache-write rate, not upstream's 1.25×", () => {
  const snapshot = buildPricingSnapshot({
    upstream: {
      "claude-haiku-4-5": {
        litellm_provider: "anthropic",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000005,
        cache_creation_input_token_cost: 0.00000125,
        cache_creation_input_token_cost_above_1hr: 0.000002,
        cache_read_input_token_cost: 1e-7,
      },
    },
    modelIds: ["claude-haiku-4-5"],
    pricedAt: "2026-01-01",
  });

  expect(snapshot.models["claude-haiku-4-5"]).toEqual({
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    cacheWriteUsdPerMillion: 2,
    cacheReadUsdPerMillion: 0.1,
  });
  expect(snapshot.models["claude-haiku-4-5"]!.cacheWriteUsdPerMillion).not.toBe(
    1.25,
  );
});

test("buildPricingSnapshot throws when a requested model is missing from upstream", () => {
  expect(() =>
    buildPricingSnapshot({
      upstream: {},
      modelIds: ["claude-haiku-4-5"],
      pricedAt: "2026-01-01",
    }),
  ).toThrow(/claude-haiku-4-5/);
});

test("buildPricingSnapshot documents the Anthropic cache-write override", () => {
  const snapshot = buildPricingSnapshot({
    upstream: {
      "claude-haiku-4-5": {
        litellm_provider: "anthropic",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000005,
        cache_creation_input_token_cost: 0.00000125,
        cache_creation_input_token_cost_above_1hr: 0.000002,
        cache_read_input_token_cost: 1e-7,
      },
    },
    modelIds: ["claude-haiku-4-5"],
    pricedAt: "2026-01-01",
  });

  expect(snapshot.overrides).toEqual([
    expect.objectContaining({
      field: "cacheWriteUsdPerMillion",
      appliesTo: "anthropic",
      applied: expect.stringContaining("2×"),
      upstream: expect.stringContaining("1.25×"),
    }),
  ]);
});

test("buildPricingSnapshot falls back to the input rate when OpenAI has no cache-creation field", () => {
  const snapshot = buildPricingSnapshot({
    upstream: {
      "gpt-5.5": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.00003,
        cache_read_input_token_cost: 5e-7,
      },
    },
    modelIds: ["gpt-5-5"],
    pricedAt: "2026-01-01",
  });

  expect(snapshot.models["gpt-5-5"]).toEqual({
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    cacheWriteUsdPerMillion: 5,
    cacheReadUsdPerMillion: 0.5,
  });
});

test("buildPricingSnapshot prefers an undated model alias and preserves snapshot metadata", () => {
  const rebuilt = buildPricingSnapshot({
    upstream: {
      "gpt-5.5-20260101": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      "gpt-5.5": { input_cost_per_token: 0.000005, output_cost_per_token: 0.00003, cache_read_input_token_cost: 0.0000005 },
    },
    modelIds: ["gpt-5-5"],
    pricedAt: "2000-01-01",
    source: "fixture",
  });
  expect(rebuilt.models["gpt-5-5"]).toEqual({
    inputUsdPerMillion: 5, outputUsdPerMillion: 30,
    cacheWriteUsdPerMillion: 5, cacheReadUsdPerMillion: 0.5,
  });
  expect(rebuilt.source).toBe("fixture");
  expect(rebuilt.pricedAt).toBe("2000-01-01");
});

test("pinned pricing contains finite nonnegative rates", () => {
  for (const rate of Object.values(pinned.models)) {
    for (const value of Object.values(rate)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }
});
