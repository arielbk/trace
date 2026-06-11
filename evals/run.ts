/**
 * Skill routing eval — entrypoint (`pnpm eval`).
 *
 * Drives user utterances through a real `claude -p` against the pinned fixture
 * and asserts which skill the agent routed to. Deliberately OFF the test/CI
 * path: non-deterministic, quota-costing, read as a report.
 *
 * Walking-skeleton: one hardcoded utterance, one PASS/FAIL line. Later slices
 * replace the hardcoded case with the full corpus and a formatted report.
 */
import { invoke, resolveConfigDir } from "./src/invoker.ts";

const UTTERANCE = "I'm starting work on the checkout-flow feature";
const EXPECTED = "trace";

async function main() {
  console.log(`config dir: ${resolveConfigDir()}`);
  console.log(`utterance:  ${UTTERANCE}`);

  const { firedSkills } = await invoke(UTTERANCE);
  const fired = firedSkills[0] ?? "<none>";
  const verdict = fired === EXPECTED ? "PASS" : "FAIL";

  console.log(`expected:   ${EXPECTED}`);
  console.log(`fired:      ${fired}${firedSkills.length > 1 ? ` (chain: ${firedSkills.join(" → ")})` : ""}`);
  console.log(`\n${verdict}`);

  process.exit(verdict === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
