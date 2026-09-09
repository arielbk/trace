import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const doc = readFileSync(join(repoRoot, "docs/local-connection.md"), "utf8");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

/** Every command the local-connection guide tells someone to run. */
function documentedCommands(): string[] {
  const spans = [...doc.matchAll(/`(eqnx [^`]+)`/g)].map(
    (match) => match[1] as string,
  );
  return [...new Set(spans)];
}

test("the guide walks the whole lifecycle, in the order it happens", () => {
  const stages = [
    /install/i,
    /eqnx setup/,
    /pair/i,
    /log(ging)? (back )?in|reboot/i,
    /revisit|come back|return/i,
    /second browser|another browser/i,
    /revoke/i,
    /upgrade|eqnx update/i,
    /uninstall/i,
  ];
  let cursor = 0;
  for (const stage of stages) {
    const found = doc.slice(cursor).search(stage);
    expect(found, `missing or out of order: ${stage}`).toBeGreaterThanOrEqual(
      0,
    );
    cursor += found + 1;
  }
});

test("the guide names the boundaries someone will otherwise hit as a bug", () => {
  // A login service is a launchd job, so the guide has to say where that
  // leaves everyone else rather than letting them discover it.
  expect(doc).toMatch(/macOS/);
  expect(doc).toMatch(/Linux/);
  expect(doc).toMatch(/Windows/);
  expect(doc).toContain("eqnx serve");
  // The hosted board is only ever the one origin this machine was configured
  // for, and a browser has to be let onto the local network to reach it.
  expect(doc).toContain("TRACE_WEB_ORIGIN");
  expect(doc).toMatch(/local network/i);
});

test("the guide covers opening the board locally as well as hosted", () => {
  expect(doc).toContain("eqnx board");
  expect(doc).toContain("eqnx board --local");
});

test("every command the guide tells you to run is one the CLI has", () => {
  const usage = runTraceCli(
    ["--help"],
    { TRACE_CURRENT_VERSION: "1.2.3" },
    process.cwd(),
  ).stdout;

  const commands = documentedCommands();
  expect(commands.length).toBeGreaterThan(5);
  for (const command of commands) {
    const [, group, subcommand] = command.split(" ");
    expect(usage, `${command} is not an EQNX command`).toContain(
      `eqnx ${group}`,
    );
    // `eqnx connection` carries the lifecycle, so its subcommands are checked
    // against the set the command itself accepts.
    if (group === "connection" && subcommand && !subcommand.startsWith("-")) {
      expect(
        usage,
        `eqnx connection ${subcommand} is not a subcommand`,
      ).toContain(subcommand);
    }
  }
});

test("the README sends someone to the guide", () => {
  expect(readme).toContain("docs/local-connection.md");
  expect(readme).toContain("eqnx board");
});
