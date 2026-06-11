/**
 * Skill routing eval — entrypoint (`pnpm eval`).
 *
 * Drives user utterances through a real `claude -p` against the pinned fixture
 * and asserts which skill the agent routed to. Deliberately OFF the test/CI
 * path: non-deterministic, quota-costing, read as a report.
 */
import { invoke, resolveConfigDir } from "./src/invoker.ts";
import { corpus } from "./corpus.ts";
import { formatReport, formatSummary } from "./src/reporter.ts";

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
    const pass =
      c.expectedSkill === "<not-trace>"
        ? !fired.startsWith("trace")
        : fired === c.expectedSkill;
    results.push({
      utterance: c.utterance,
      expected: c.expectedSkill,
      fired,
      pass,
      note: c.note,
    });
  }

  console.log(formatReport(results));
  const summary = formatSummary(results);
  console.log(`\n${summary}`);

  const failed = results.filter((r) => !r.pass).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
