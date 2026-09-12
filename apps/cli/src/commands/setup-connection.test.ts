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
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  MANAGED_CONNECTION_LABEL,
  type ConnectionServiceDependencies,
  type LaunchctlResult,
} from "../connection-service.ts";
import { interactiveSetupOperation } from "./setup-interactive.ts";
import { setupOperation } from "./setup-operations.ts";
import type {
  PromptResult,
  SetupPrompt,
  TargetSelectionRequest,
} from "./setup-prompt.ts";

const CLI_PATH = "/opt/global/bin/trace";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trace-setup-connection-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function launchd(
  answer: (args: string[]) => LaunchctlResult = () => ({
    status: 0,
    stderr: "",
  }),
): { calls: string[][]; service: ConnectionServiceDependencies } {
  const calls: string[][] = [];
  return {
    calls,
    service: {
      platform: "darwin",
      uid: 501,
      nodePath: "/opt/homebrew/bin/node",
      launchctl: (args) => {
        calls.push(args);
        return answer(args);
      },
    },
  };
}

/** launchd answers `print` for a job it has not been handed. */
const notLoaded = (args: string[]): LaunchctlResult =>
  args[0] === "print"
    ? { status: 113, stderr: "Could not find service\n" }
    : { status: 0, stderr: "" };

function context(service?: ConnectionServiceDependencies) {
  return {
    env: { HOME: home, TRACE_CLI_PATH: CLI_PATH },
    cwd: home,
    stdin: "",
    service,
  };
}

function plistPath(): string {
  return join(
    home,
    "Library",
    "LaunchAgents",
    `${MANAGED_CONNECTION_LABEL}.plist`,
  );
}

test("an applied setup installs and starts the local connection", () => {
  const { calls, service } = launchd(notLoaded);

  const result = setupOperation(
    ["--target", `codex=${join(home, "codex")}`, "--yes"],
    context(service),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Local connection installed");
  expect(existsSync(plistPath())).toBe(true);
  expect(calls.map(([verb]) => verb)).toEqual([
    "print",
    "bootstrap",
    "kickstart",
  ]);
});

test("setup installs the connection even when it registers no integration", () => {
  const { calls, service } = launchd(notLoaded);

  // `--registered` with an empty registry reconciles nothing, which is the
  // shape of a user who only wants the connection.
  const result = setupOperation(["--registered", "--yes"], context(service));

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Local connection installed");
  expect(calls.map(([verb]) => verb)).toEqual([
    "print",
    "bootstrap",
    "kickstart",
  ]);
});

test("a preview installs nothing", () => {
  const { calls, service } = launchd(notLoaded);

  const result = setupOperation(
    ["--target", `codex=${join(home, "codex")}`],
    context(service),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Re-run with --yes");
  expect(calls).toEqual([]);
  expect(existsSync(plistPath())).toBe(false);
});

test("a batch where every target fails preflight installs nothing", () => {
  const claudeRoot = join(home, ".claude");
  // An unowned skill directory is the guardrail that skips this target.
  mkdirSync(join(claudeRoot, "skills", "trace"), { recursive: true });
  writeFileSync(join(claudeRoot, "skills", "trace", "SKILL.md"), "mine\n");

  const { calls, service } = launchd(notLoaded);
  const result = setupOperation(
    ["--target", `claude=${claudeRoot}`, "--yes"],
    context(service),
  );

  expect(result.exitCode).not.toBe(0);
  expect(calls).toEqual([]);
  expect(existsSync(plistPath())).toBe(false);
});

test("running setup again does not restart a healthy connection", () => {
  const first = launchd(notLoaded);
  setupOperation(
    ["--target", `codex=${join(home, "codex")}`, "--yes"],
    context(first.service),
  );

  const second = launchd();
  const result = setupOperation(
    ["--target", `codex=${join(home, "codex")}`, "--yes"],
    context(second.service),
  );

  expect(result.stdout).toContain("already installed");
  expect(second.calls.map(([verb]) => verb)).toEqual(["print"]);
});

test("removing an integration leaves the connection installed", () => {
  const install = launchd(notLoaded);
  const root = join(home, "codex");
  setupOperation(
    ["--target", `codex=${root}`, "--yes"],
    context(install.service),
  );

  const removal = launchd();
  const result = setupOperation(
    ["--target", `codex=${root}`, "--remove", "--yes"],
    context(removal.service),
  );

  expect(result.exitCode).toBe(0);
  // Removing the last integration is not a request to disconnect the browser.
  expect(existsSync(plistPath())).toBe(true);
  expect(removal.calls).toEqual([]);
});

test("launchd refusing the job does not fail the integration install", () => {
  const { service } = launchd((args) =>
    args[0] === "bootstrap"
      ? { status: 5, stderr: "Input/output error\n" }
      : notLoaded(args),
  );

  const result = setupOperation(
    ["--target", `codex=${join(home, "codex")}`, "--yes"],
    context(service),
  );

  // The skills landed; only the login service did not.
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(home, "codex", "skills", "trace", "SKILL.md"))).toBe(
    true,
  );
  expect(result.stdout).toContain("launchctl bootstrap gui/501");
});

test("a platform without launchd says so and still installs integrations", () => {
  const { calls, service } = launchd();

  const result = setupOperation(
    ["--target", `codex=${join(home, "codex")}`, "--yes"],
    {
      ...context({ ...service, platform: "linux" }),
      platform: "linux",
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("eqnx serve");
  expect(calls).toEqual([]);
  expect(existsSync(plistPath())).toBe(false);
});

test("a temporary HOME has no login session to install into", () => {
  // No launchctl is injected, so this is the production path — and it must not
  // reach the developer's own launchd from a test fixture's HOME.
  const result = setupOperation(
    ["--target", `codex=${join(home, "codex")}`, "--yes"],
    { env: { HOME: home, TRACE_CLI_PATH: CLI_PATH }, cwd: home, stdin: "" },
  );

  expect(result.exitCode).toBe(0);
  expect(existsSync(plistPath())).toBe(false);
});

/** A prompt that selects everything offered and answers the confirmation. */
function fakePrompt(confirm: boolean): SetupPrompt {
  return {
    async selectTargets(request: TargetSelectionRequest) {
      return { cancelled: false, value: request.initialValues } as PromptResult<
        string[]
      >;
    },
    async confirm() {
      return { cancelled: !confirm, value: confirm } as PromptResult<boolean>;
    },
    note() {},
    warn() {},
  } as SetupPrompt;
}

test("cancelling the interactive confirmation installs nothing", async () => {
  const { calls, service } = launchd(notLoaded);
  const codexRoot = join(home, ".codex");
  mkdirSync(codexRoot, { recursive: true });

  const result = await interactiveSetupOperation(
    { ...context(service), env: { ...context().env, CODEX_HOME: codexRoot } },
    fakePrompt(false),
  );

  expect(result.stdout).toContain("cancelled");
  expect(calls).toEqual([]);
  expect(existsSync(plistPath())).toBe(false);
});

test("a confirmed interactive setup installs the connection", async () => {
  const { calls, service } = launchd(notLoaded);
  const codexRoot = join(home, ".codex");
  mkdirSync(codexRoot, { recursive: true });

  const result = await interactiveSetupOperation(
    { ...context(service), env: { ...context().env, CODEX_HOME: codexRoot } },
    fakePrompt(true),
  );

  expect(result.exitCode).toBe(0);
  expect(calls.map(([verb]) => verb)).toEqual([
    "print",
    "bootstrap",
    "kickstart",
  ]);
  expect(readFileSync(plistPath(), "utf8")).toContain(CLI_PATH);
});
