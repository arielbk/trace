/**
 * Skill routing eval — entrypoint (`pnpm eval`).
 *
 * Drives user utterances through a real `claude -p` against the pinned fixture
 * and asserts which skill the agent routed to. Deliberately OFF the test/CI
 * path: non-deterministic, quota-costing, read as a report.
 */
import { invoke, resolveConfigDir } from "./src/invoker.ts";
import { corpus } from "./corpus.ts";

export interface EvalResult {
  utterance: string;
  expected: string;
  fired: string;
  pass: boolean;
  note: string;
}

async function main() {
  let configDir: string;
  try {
    configDir = resolveConfigDir();
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log(`config dir: ${configDir}`);
  console.log(`cases:      ${corpus.length}\n`);

  const results: EvalResult[] = [];

  for (const c of corpus) {
    const { firedSkills } = await invoke(c.utterance);
    const fired = firedSkills[0] ?? "<none>";
    const pass = fired === c.expectedSkill;
    results.push({
      utterance: c.utterance,
      expected: c.expectedSkill,
      fired,
      pass,
      note: c.note,
    });
    const verdict = pass ? "PASS" : "FAIL";
    console.log(`[${verdict}] ${c.utterance}`);
    if (!pass) {
      console.log(`       expected=${c.expectedSkill}  fired=${fired}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ""}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
