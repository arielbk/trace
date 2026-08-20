import snapshot from "./pricing-table.json" with { type: "json" };
import type { SessionTool, TokenTotals } from "./types.ts";

export type ModelRate = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
};

type PricingSnapshot = {
  pricedAt: string;
  models: Record<string, ModelRate>;
};

const table = snapshot as PricingSnapshot;

export const pricedAt = table.pricedAt;

function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replaceAll(".", "-")
    .replace(/-\d{8}$/, "");
}

export function resolveRate(
  _tool: SessionTool,
  model: string | null,
): ModelRate | null {
  if (!model) return null;
  return table.models[normalizeModelId(model)] ?? null;
}

export function costFromTokenTotals(
  totals: TokenTotals,
  rate: ModelRate,
): number {
  return (
    (totals.inputTokens * rate.inputUsdPerMillion +
      totals.outputTokens * rate.outputUsdPerMillion +
      totals.cacheCreationInputTokens * rate.cacheWriteUsdPerMillion +
      totals.cacheReadInputTokens * rate.cacheReadUsdPerMillion) /
    1_000_000
  );
}
