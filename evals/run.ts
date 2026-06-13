/**
 * Skill routing eval — entrypoint (`pnpm eval`).
 *
 * Drives user utterances through a real `claude -p` against the pinned fixture
 * and asserts which skill the agent routed to. Deliberately OFF the test/CI
 * path: non-deterministic, quota-costing, read as a report.
 */
import { invoke, resolveConfigDir, EVAL_MODEL } from "./src/invoker.ts";
import { normalizeSkill } from "./src/parser.ts";
import { corpus } from "./corpus.ts";
import { formatHeader, formatRow, formatSummary } from "./src/reporter.ts";

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
  console.log(`model:      ${EVAL_MODEL}`);
  console.log(`cases:      ${corpus.length}\n`);

  const results: EvalResult[] = [];

  // Stream the report as cases complete: print the header up front, then one
  // row per case as it finishes. Each `claude -p` call costs quota, so showing
  // results live lets the user spot a broken run and Ctrl-C early.
  console.log(formatHeader());

  for (const c of corpus) {
    const { firedSkills } = await invoke(c.utterance);
    const fired = firedSkills[0] ? normalizeSkill(firedSkills[0]) : "<none>";
    const pass =
      c.expectedSkill === "<not-trace>"
        ? !fired.startsWith("trace")
        : fired === c.expectedSkill;
    const result: EvalResult = {
      utterance: c.utterance,
      expected: c.expectedSkill,
      fired,
      pass,
      note: c.note,
    };
    results.push(result);
    console.log(formatRow(result));
  }

  const summary = formatSummary(results);
  console.log(`\n${summary}`);

  const failed = results.filter((r) => !r.pass).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
