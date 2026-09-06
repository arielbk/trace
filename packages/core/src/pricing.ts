import snapshot from "./pricing-table.json" with { type: "json" };
import type { Session, SessionTool, TokenTotals } from "./types.ts";

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
  const key = normalizeModelId(model);
  return Object.hasOwn(table.models, key) ? table.models[key]! : null;
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

export type SessionCostRollup = {
  totalUsd: number | null;
  pricedSessions: number;
  unpricedSessions: number;
};

export function costFromSessions(
  sessions: ReadonlyArray<Pick<Session, "tool" | "model" | "tokenTotals">>,
): SessionCostRollup {
  let pricedSessions = 0;
  let unpricedSessions = 0;
  let totalUsd = 0;

  for (const session of sessions) {
    const rate = resolveRate(session.tool, session.model);
    if (!rate) {
      unpricedSessions += 1;
      continue;
    }
    pricedSessions += 1;
    totalUsd += costFromTokenTotals(session.tokenTotals, rate);
  }

  return {
    totalUsd: pricedSessions === 0 ? null : totalUsd,
    pricedSessions,
    unpricedSessions,
  };
}
