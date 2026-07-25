import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

test("README documents the interactive target picker", () => {
  expect(readme).toMatch(/interactive|picker|checklist/i);
  // The two facts a first-time user needs: everything starts selected, and
  // nothing is written before an explicit confirmation.
  expect(readme).toMatch(/preselected|pre-selected|all selected/i);
  expect(readme).toMatch(/confirm/i);
});

test("README documents --yes as the non-interactive apply", () => {
  expect(readme).toContain("trace setup --yes");
  expect(readme).toMatch(/--yes[\s\S]{0,400}?without prompting/i);
});

test("README says explicit targets and removal skip the picker", () => {
  expect(readme).toContain("trace setup --tool codex");
  expect(readme).toContain("trace setup --remove");
  expect(readme).toMatch(/skip[a-z]* the picker/i);
});

test("README says update reconciles every registered target, not a selection", () => {
  expect(readme).toContain("trace update");
  expect(readme).toMatch(/update[\s\S]{0,400}?never opens the picker/i);
});
