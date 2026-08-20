export type LiteLLMModelRow = {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  cache_read_input_token_cost?: number;
};

export type PricingSnapshot = {
  pricedAt: string;
  source: string;
  overrides: unknown;
  models: Record<
    string,
    {
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
      cacheWriteUsdPerMillion: number;
      cacheReadUsdPerMillion: number;
    }
  >;
};

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const ANTHROPIC_OVERRIDE = {
  field: "cacheWriteUsdPerMillion",
  appliesTo: "anthropic",
  upstream: "cache_creation_input_token_cost (1.25× input, 5-minute TTL)",
  applied: "cache_creation_input_token_cost_above_1hr (2× input, 1-hour TTL)",
  reason:
    "Claude Code writes prompt cache at 1-hour TTL. Upstream's cache-write field is the 5-minute rate; using it unmodified understates that bucket by 37.5%.",
};

export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replaceAll(".", "-")
    .replace(/-\d{8}$/, "");
}

function perMillion(costPerToken: number): number {
  return Number((costPerToken * 1_000_000).toPrecision(12));
}

function findUpstreamRow(
  upstream: Record<string, unknown>,
  modelId: string,
): LiteLLMModelRow | null {
  const matches: Array<[string, LiteLLMModelRow]> = [];
  for (const [key, value] of Object.entries(upstream)) {
    if (key === "sample_spec") continue;
    if (typeof value !== "object" || value === null) continue;
    if (normalizeModelId(key) !== modelId) continue;
    matches.push([key, value as LiteLLMModelRow]);
  }
  if (matches.length === 0) return null;
  const unprefixed = matches.filter(([key]) => !key.includes("/"));
  const pool = unprefixed.length > 0 ? unprefixed : matches;
  const unsuffixed = pool.filter(([key]) => !/\d{8}/.test(key));
  return (unsuffixed.length > 0 ? unsuffixed : pool)[0]![1];
}

function rateFromRow(row: LiteLLMModelRow) {
  const inputUsdPerMillion = perMillion(row.input_cost_per_token ?? 0);
  const outputUsdPerMillion = perMillion(row.output_cost_per_token ?? 0);
  const cacheWriteUsdPerMillion =
    row.litellm_provider === "anthropic"
      ? perMillion(
          row.cache_creation_input_token_cost_above_1hr ??
            2 * (row.input_cost_per_token ?? 0),
        )
      : perMillion(
          row.cache_creation_input_token_cost ?? row.input_cost_per_token ?? 0,
        );
  const cacheReadUsdPerMillion = perMillion(
    row.cache_read_input_token_cost ?? 0,
  );
  return {
    inputUsdPerMillion,
    outputUsdPerMillion,
    cacheWriteUsdPerMillion,
    cacheReadUsdPerMillion,
  };
}

export function buildPricingSnapshot(input: {
  upstream: Record<string, unknown>;
  modelIds: string[];
  pricedAt: string;
  source?: string;
}): PricingSnapshot {
  const models: PricingSnapshot["models"] = {};
  for (const modelId of input.modelIds) {
    const row = findUpstreamRow(input.upstream, modelId);
    if (!row) {
      throw new Error(`No LiteLLM row for model ${modelId}`);
    }
    models[modelId] = rateFromRow(row);
  }
  return {
    pricedAt: input.pricedAt,
    source: input.source ?? LITELLM_PRICES_URL,
    overrides: [ANTHROPIC_OVERRIDE],
    models,
  };
}
