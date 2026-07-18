import { expect, test } from "vitest";
import {
  addTokenTotals,
  emptyTokenTotals,
  freshTokenTotal,
  tokenTotalsFromUsage,
} from "./token-totals.ts";

test("emptyTokenTotals returns an all-zero totals value", () => {
  expect(emptyTokenTotals()).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  });
});

test("freshTokenTotal sums input and output, excluding cache", () => {
  expect(
    freshTokenTotal({
      inputTokens: 81123,
      outputTokens: 5,
      cacheCreationInputTokens: 999,
      cacheReadInputTokens: 1_000_000,
      totalTokens: 16_317_514,
    }),
  ).toBe(81128);
});

test("addTokenTotals sums every field of two totals", () => {
  const left = {
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 4,
    totalTokens: 10,
  };
  const right = {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 30,
    cacheReadInputTokens: 40,
    totalTokens: 100,
  };

  expect(addTokenTotals(left, right)).toEqual({
    inputTokens: 11,
    outputTokens: 22,
    cacheCreationInputTokens: 33,
    cacheReadInputTokens: 44,
    totalTokens: 110,
  });
});

test("tokenTotalsFromUsage reads snake_case keys and derives total from parts", () => {
  expect(
    tokenTotalsFromUsage({
      input_tokens: 5,
      output_tokens: 7,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    }),
  ).toEqual({
    inputTokens: 5,
    outputTokens: 7,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 3,
    totalTokens: 17,
  });
});

test("tokenTotalsFromUsage splits OpenAI cached input from input tokens", () => {
  expect(
    tokenTotalsFromUsage({
      input_tokens: 17,
      output_tokens: 29,
      cached_input_tokens: 11,
    }),
  ).toEqual({
    inputTokens: 6,
    outputTokens: 29,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 11,
    totalTokens: 46,
  });
});

test("tokenTotalsFromUsage reads camelCase keys", () => {
  expect(
    tokenTotalsFromUsage({
      inputTokens: 5,
      outputTokens: 7,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
    }),
  ).toEqual({
    inputTokens: 5,
    outputTokens: 7,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 3,
    totalTokens: 17,
  });
});

test("tokenTotalsFromUsage prefers an explicit total over the sum of parts", () => {
  expect(
    tokenTotalsFromUsage({
      input_tokens: 5,
      output_tokens: 7,
      total_tokens: 999,
    }),
  ).toEqual({
    inputTokens: 5,
    outputTokens: 7,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 999,
  });
});

test("tokenTotalsFromUsage returns empty totals for undefined usage", () => {
  expect(tokenTotalsFromUsage(undefined)).toEqual(emptyTokenTotals());
});
