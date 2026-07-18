import type { TokenTotals } from "./types.ts";

export type RawTokenUsage = {
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cache_creation_input_tokens?: number;
  cacheCreationInputTokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cacheReadInputTokens?: number;
  total_tokens?: number;
  totalTokens?: number;
};

/**
 * Fresh token spend: input + output only, excluding cache creation/read. This
 * is the headline figure surfaced in the UI — cache reads are cheap context
 * replay and would otherwise dominate the total without reflecting real spend.
 */
export function freshTokenTotal(totals: TokenTotals): number {
  return totals.inputTokens + totals.outputTokens;
}

export function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };
}

export function tokenTotalsFromUsage(
  usage: RawTokenUsage | undefined,
): TokenTotals {
  if (!usage) {
    return emptyTokenTotals();
  }

  const rawInputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
  const cacheCreationInputTokens =
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens =
    usage.cached_input_tokens ??
    usage.cache_read_input_tokens ??
    usage.cacheReadInputTokens ??
    0;
  const inputTokens =
    usage.cached_input_tokens === undefined
      ? rawInputTokens
      : Math.max(0, rawInputTokens - cacheReadInputTokens);

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      usage.total_tokens ??
      usage.totalTokens ??
      inputTokens +
        outputTokens +
        cacheCreationInputTokens +
        cacheReadInputTokens,
  };
}

export function addTokenTotals(
  left: TokenTotals,
  right: TokenTotals,
): TokenTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationInputTokens:
      left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens:
      left.cacheReadInputTokens + right.cacheReadInputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}
