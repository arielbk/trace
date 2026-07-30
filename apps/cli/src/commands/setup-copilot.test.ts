import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setupOperation } from "./setup-operations.ts";

const CLI_PATH = "/opt/global/bin/trace";

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function targets(home: string): { tool: string; root: string; hooks: string[] }[] {
  return JSON.parse(
    readFileSync(join(home, ".trace", "integrations.json"), "utf8"),
  ).targets;
}

function hooksFile(root: string): {
  version?: number;
  hooks?: Record<string, Array<Record<string, string>>>;
} {
  return JSON.parse(readFileSync(join(root, "hooks", "trace.json"), "utf8"));
}

test("Copilot setup installs skills and a version-1 hooks file on the absolute CLI path", () => {
  const { dir, cleanup } = tempDir("trace-setup-copilot-");
  try {
    const result = setupOperation(["--tool", "copilot", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });
    const root = join(dir, ".copilot");

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "skills", "trace", "SKILL.md"))).toBe(true);

    const hooks = hooksFile(root);
    expect(hooks.version).toBe(1);
    expect(hooks.hooks?.sessionStart?.[0]).toEqual({
      type: "command",
      bash: `${CLI_PATH} hook session-start`,
      powershell: `${CLI_PATH} hook session-start`,
    });
    // Copilot ignores command-hook stdout at sessionStart, so the binding
    // nudge rides a prompt-type hook.
    expect(hooks.hooks?.sessionStart?.[1]?.type).toBe("prompt");
    expect(hooks.hooks?.agentStop?.[0]?.bash).toBe(`${CLI_PATH} hook stop`);
    expect(hooks.hooks?.subagentStop?.[0]?.bash).toBe(
      `${CLI_PATH} hook subagent-stop`,
    );

    expect(targets(dir)[0]).toMatchObject({
      tool: "copilot",
      root,
      hooks: ["sessionStart", "agentStop", "subagentStop"],
    });
  } finally {
    cleanup();
  }
});

test("Copilot setup honors COPILOT_HOME", () => {
  const { dir, cleanup } = tempDir("trace-setup-copilot-home-");
  try {
    const root = join(dir, "custom-copilot");
    const result = setupOperation(["--tool", "copilot", "--yes"], {
      env: { HOME: dir, COPILOT_HOME: root, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "hooks", "trace.json"))).toBe(true);
    expect(existsSync(join(dir, ".copilot"))).toBe(false);
    expect(targets(dir)[0]).toMatchObject({ tool: "copilot", root });
  } finally {
    cleanup();
  }
});

test("a CLI path needing quotes is quoted per shell", () => {
  const { dir, cleanup } = tempDir("trace-setup-copilot-quote-");
  try {
    const cliPath = "/opt/global bin/trace";
    setupOperation(["--tool", "copilot", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: cliPath },
      cwd: dir,
      stdin: "",
    });

    const hooks = hooksFile(join(dir, ".copilot"));
    expect(hooks.hooks?.agentStop?.[0]?.bash).toBe(`'${cliPath}' hook stop`);
    // A quoted path is not executable on its own in PowerShell.
    expect(hooks.hooks?.agentStop?.[0]?.powershell).toBe(`& '${cliPath}' hook stop`);
  } finally {
    cleanup();
  }
});

test("Copilot is detected by bare setup and reconciled idempotently", () => {
  const { dir, cleanup } = tempDir("trace-setup-copilot-detect-");
  try {
    const root = join(dir, ".copilot");
    mkdirSync(root);

    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    expect(setupOperation(["--yes"], { env, cwd: dir, stdin: "" }).exitCode).toBe(0);
    expect(targets(dir).map(({ tool }) => tool)).toEqual(["copilot"]);

    // Re-running is the shim-update path and must stay a no-op byte-wise.
    const before = readFileSync(join(root, "hooks", "trace.json"), "utf8");
    expect(setupOperation(["--yes"], { env, cwd: dir, stdin: "" }).exitCode).toBe(0);
    expect(readFileSync(join(root, "hooks", "trace.json"), "utf8")).toBe(before);
    expect(targets(dir)).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("setup refuses to overwrite a Copilot hooks file Trace does not own", () => {
  const { dir, cleanup } = tempDir("trace-setup-copilot-unowned-");
  try {
    const root = join(dir, ".copilot");
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "trace.json"), '{"version":1}\n');

    const result = setupOperation(["--tool", "copilot", "--yes"], {
      env: { HOME: dir, TRACE_CLI_PATH: CLI_PATH },
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unowned Copilot hooks file");
    expect(readFileSync(join(root, "hooks", "trace.json"), "utf8")).toBe(
      '{"version":1}\n',
    );
  } finally {
    cleanup();
  }
});

test("removal deletes the Copilot hooks file and deregisters the target", () => {
  const { dir, cleanup } = tempDir("trace-setup-copilot-remove-");
  try {
    const env = { HOME: dir, TRACE_CLI_PATH: CLI_PATH };
    setupOperation(["--tool", "copilot", "--yes"], { env, cwd: dir, stdin: "" });

    const root = join(dir, ".copilot");
    // A neighbouring hooks file is not Trace's to remove.
    writeFileSync(join(root, "hooks", "other.json"), "{}\n");

    const result = setupOperation(["--remove", "--tool", "copilot", "--yes"], {
      env,
      cwd: dir,
      stdin: "",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "hooks", "trace.json"))).toBe(false);
    expect(existsSync(join(root, "hooks", "other.json"))).toBe(true);
    expect(existsSync(join(root, "skills", "trace"))).toBe(false);
    expect(targets(dir)).toEqual([]);
  } finally {
    cleanup();
  }
});
