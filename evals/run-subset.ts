/**
 * Subset runner — run only the cases whose utterance contains a given keyword.
 *
 * Usage:
 *   CLAUDE_CONFIG_DIR=~/.claude-sandbox node evals/run-subset.ts steal under
 *
 * Each positional arg is matched as a substring of the utterance or note field.
 * Pass no args to run all cases (same as `pnpm eval`).
 */
import { invoke, resolveConfigDir } from "./src/invoker.ts";
import { corpus } from "./corpus.ts";
import { formatReport, formatSummary } from "./src/reporter.ts";
import type { EvalResult } from "./run.ts";

async function main() {
  let configDir: string;
  try {
    configDir = resolveConfigDir();
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const filters = process.argv.slice(2);
  const cases =
    filters.length === 0
      ? corpus
      : corpus.filter((c) =>
          filters.some(
            (f) =>
              c.utterance.toLowerCase().includes(f.toLowerCase()) ||
              c.note.toLowerCase().includes(f.toLowerCase()),
          ),
        );

  console.log(`config dir: ${configDir}`);
  console.log(`filters:    ${filters.length > 0 ? filters.join(", ") : "(none)"}`);
  console.log(`cases:      ${cases.length}\n`);

  const results: EvalResult[] = [];

  for (const c of cases) {
    process.stdout.write(`  ${c.utterance.slice(0, 60).padEnd(62)} `);
    const { firedSkills } = await invoke(c.utterance);
    const fired = firedSkills[0] ?? "<none>";
    const pass =
      c.expectedSkill === "<not-trace>"
        ? !fired.startsWith("trace")
        : fired === c.expectedSkill;
    results.push({ utterance: c.utterance, expected: c.expectedSkill, fired, pass, note: c.note });
    console.log(pass ? "✓" : `✗  (expected ${c.expectedSkill}, got ${fired})`);
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
