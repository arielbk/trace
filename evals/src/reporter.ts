import type { EvalResult } from "../run.ts";

const COL_UTTERANCE = 45;
const COL_EXPECTED = 20;
const COL_FIRED = 20;
const COL_VERDICT = 7;

function pad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len - 1) + "…";
  return s.padEnd(len);
}

export function formatReport(results: EvalResult[]): string {
  const header =
    pad("Utterance", COL_UTTERANCE) +
    pad("Expected", COL_EXPECTED) +
    pad("Fired", COL_FIRED) +
    "Verdict";
  const sep = "-".repeat(COL_UTTERANCE + COL_EXPECTED + COL_FIRED + COL_VERDICT);

  const rows = results.map((r) => {
    const verdict = r.pass ? "PASS" : "FAIL";
    return (
      pad(r.utterance, COL_UTTERANCE) +
      pad(r.expected, COL_EXPECTED) +
      pad(r.fired, COL_FIRED) +
      verdict
    );
  });

  return [header, sep, ...rows].join("\n");
}

export function formatSummary(results: EvalResult[]): string {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const base = `${passed}/${results.length} passed`;
  return failed > 0 ? `${base}, ${failed} failed` : base;
}
