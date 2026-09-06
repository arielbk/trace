// Refresh the pinned LiteLLM rate table committed beside the pricing module.
// Fetches upstream, re-trims to the models already in the snapshot, re-applies
// the documented cache-write override, and rewrites pricedAt. A reviewable
// commit — never a runtime fetch.
//
// Run: node --experimental-strip-types scripts/refresh-pricing-table.ts

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPricingSnapshot } from "../packages/core/src/pricing-refresh.ts";

const snapshotPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/core/src/pricing-table.json",
);

const current = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
  source: string;
  models: Record<string, unknown>;
};

const response = await fetch(current.source);
if (!response.ok) {
  throw new Error(`Failed to fetch ${current.source}: ${response.status}`);
}

const next = buildPricingSnapshot({
  upstream: (await response.json()) as Record<string, unknown>,
  modelIds: Object.keys(current.models),
  pricedAt: new Date().toISOString().slice(0, 10),
  source: current.source,
});

writeFileSync(snapshotPath, `${JSON.stringify(next, null, 2)}\n`);
process.stdout.write(`wrote ${snapshotPath} pricedAt=${next.pricedAt}\n`);
