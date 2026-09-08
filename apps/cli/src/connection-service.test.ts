import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  installConnectionService,
  MANAGED_CONNECTION_LABEL,
  readConnectionServiceState,
  readInstalledConnectionCli,
  resolveConnectionLogPaths,
  resolveLaunchAgentPath,
  rotateConnectionLogs,
  type ConnectionServiceDependencies,
  type LaunchctlResult,
} from "./connection-service.ts";

const NODE_PATH = "/opt/homebrew/bin/node";
const CLI_PATH = "/opt/global/bin/trace";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trace-connection-service-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Records every launchctl invocation instead of touching real launchd. */
function fakeLaunchctl(
  answer: (args: string[]) => LaunchctlResult = () => ({
    status: 0,
    stderr: "",
  }),
): { calls: string[][]; run: (args: string[]) => LaunchctlResult } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      return answer(args);
    },
  };
}

/** launchd answers `print` for a job it has not been handed. */
const notLoaded = (args: string[]): LaunchctlResult =>
  args[0] === "print"
    ? { status: 113, stderr: "Could not find service\n" }
    : { status: 0, stderr: "" };

function dependencies(
  launchctl: (args: string[]) => LaunchctlResult,
  overrides: ConnectionServiceDependencies = {},
): ConnectionServiceDependencies {
  return {
    platform: "darwin",
    uid: 501,
    nodePath: NODE_PATH,
    launchctl,
    ...overrides,
  };
}

function env(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  return { HOME: home, TRACE_CLI_PATH: CLI_PATH, ...extra };
}

/** Parses the written plist the way launchd would, when plutil is available. */
function parsePlist(path: string): Record<string, unknown> | undefined {
  const converted = spawnSync("plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
  });
  if (converted.status !== 0) return undefined;
  return JSON.parse(converted.stdout) as Record<string, unknown>;
}

test("an applied install writes the user LaunchAgent, then hands it to launchd", () => {
  const launchctl = fakeLaunchctl(notLoaded);

  const outcome = installConnectionService(env(), dependencies(launchctl.run));

  expect(outcome).toEqual({
    kind: "installed",
    plistPath: join(
      home,
      "Library",
      "LaunchAgents",
      `${MANAGED_CONNECTION_LABEL}.plist`,
    ),
  });
  expect(resolveLaunchAgentPath(env())).toBe(
    join(home, "Library", "LaunchAgents", `${MANAGED_CONNECTION_LABEL}.plist`),
  );

  // The plist exists before launchd is asked to load it, and the job is loaded
  // into this user's GUI domain before it is started.
  expect(launchctl.calls).toEqual([
    ["print", `gui/501/${MANAGED_CONNECTION_LABEL}`],
    [
      "bootstrap",
      "gui/501",
      join(
        home,
        "Library",
        "LaunchAgents",
        `${MANAGED_CONNECTION_LABEL}.plist`,
      ),
    ],
    ["kickstart", "-k", `gui/501/${MANAGED_CONNECTION_LABEL}`],
  ]);
});

test("the LaunchAgent runs the connection from absolute Node and CLI paths", () => {
  installConnectionService(env(), dependencies(fakeLaunchctl(notLoaded).run));

  const plistPath = resolveLaunchAgentPath(env());
  const parsed = parsePlist(plistPath);
  if (!parsed) {
    // No plutil on this host: fall back to the rendered XML.
    const xml = readFileSync(plistPath, "utf8");
    expect(xml).toContain(`<string>${NODE_PATH}</string>`);
    expect(xml).toContain(`<string>${CLI_PATH}</string>`);
    return;
  }

  expect(parsed.Label).toBe(MANAGED_CONNECTION_LABEL);
  // A login service inherits no shell, so nothing here may be resolved on PATH.
  expect(parsed.ProgramArguments).toEqual([
    NODE_PATH,
    CLI_PATH,
    "connection",
    "run",
  ]);
  expect(parsed.RunAtLoad).toBe(true);
  expect(parsed.KeepAlive).toBe(true);
  expect(parsed.ThrottleInterval).toBeGreaterThan(0);
  expect(parsed.StandardOutPath).toBe(
    join(home, ".trace", "logs", "connection.log"),
  );
  expect(parsed.StandardErrorPath).toBe(
    join(home, ".trace", "logs", "connection.error.log"),
  );
  expect((parsed.EnvironmentVariables as Record<string, string>).HOME).toBe(
    home,
  );
});

test("the hosted origin is written into the job, since login services inherit no shell env", () => {
  installConnectionService(
    env({ TRACE_WEB_ORIGIN: "https://trace-hosted.example" }),
    dependencies(fakeLaunchctl(notLoaded).run),
  );

  const xml = readFileSync(resolveLaunchAgentPath(env()), "utf8");
  expect(xml).toContain("TRACE_WEB_ORIGIN");
  expect(xml).toContain("https://trace-hosted.example");
});

test("an origin the API would refuse is not written into the job", () => {
  installConnectionService(
    env({ TRACE_WEB_ORIGIN: "http://insecure.example" }),
    dependencies(fakeLaunchctl(notLoaded).run),
  );

  const xml = readFileSync(resolveLaunchAgentPath(env()), "utf8");
  expect(xml).not.toContain("TRACE_WEB_ORIGIN");
  expect(xml).not.toContain("insecure.example");
});

test("XML metacharacters in a path survive the round trip through the plist", () => {
  const awkward = "/opt/a & b/<trace>";

  installConnectionService(
    env({ TRACE_CLI_PATH: awkward }),
    dependencies(fakeLaunchctl(notLoaded).run),
  );

  const plistPath = resolveLaunchAgentPath(env());
  const xml = readFileSync(plistPath, "utf8");
  expect(xml).toContain("&amp;");
  expect(xml).toContain("&lt;trace&gt;");
  expect(xml).not.toContain("<string>/opt/a & b/<trace></string>");

  const parsed = parsePlist(plistPath);
  if (parsed) {
    expect(parsed.ProgramArguments).toEqual([
      NODE_PATH,
      awkward,
      "connection",
      "run",
    ]);
  }
});

test("the connection log directory is created owner-only", () => {
  installConnectionService(env(), dependencies(fakeLaunchctl(notLoaded).run));

  const logDir = join(home, ".trace", "logs");
  expect(existsSync(logDir)).toBe(true);
  expect(statSync(logDir).mode & 0o777).toBe(0o700);
});

test("installing again over an unchanged, loaded job leaves it running", () => {
  installConnectionService(env(), dependencies(fakeLaunchctl(notLoaded).run));

  const second = fakeLaunchctl();
  const outcome = installConnectionService(env(), dependencies(second.run));

  expect(outcome.kind).toBe("unchanged");
  // Nothing is torn down and restarted just because setup ran twice.
  expect(second.calls).toEqual([
    ["print", `gui/501/${MANAGED_CONNECTION_LABEL}`],
  ]);
});

test("a changed executable path reloads the job onto the new plist", () => {
  installConnectionService(env(), dependencies(fakeLaunchctl(notLoaded).run));

  const second = fakeLaunchctl();
  const outcome = installConnectionService(
    env({ TRACE_CLI_PATH: "/opt/global/bin/trace-next" }),
    dependencies(second.run),
  );

  expect(outcome.kind).toBe("reconciled");
  expect(second.calls.map(([verb]) => verb)).toEqual([
    "print",
    "bootout",
    "bootstrap",
    "kickstart",
  ]);
  expect(readFileSync(resolveLaunchAgentPath(env()), "utf8")).toContain(
    "/opt/global/bin/trace-next",
  );
});

test("a job launchd is not holding is bootstrapped again without a bootout", () => {
  installConnectionService(env(), dependencies(fakeLaunchctl(notLoaded).run));

  const second = fakeLaunchctl(notLoaded);
  const outcome = installConnectionService(env(), dependencies(second.run));

  expect(outcome.kind).toBe("installed");
  expect(second.calls.map(([verb]) => verb)).toEqual([
    "print",
    "bootstrap",
    "kickstart",
  ]);
});

test("platforms without launchd keep foreground serve and get no job", () => {
  const launchctl = fakeLaunchctl();

  const outcome = installConnectionService(
    env(),
    dependencies(launchctl.run, { platform: "linux" }),
  );

  expect(outcome.kind).toBe("unsupported");
  expect(outcome.kind === "unsupported" && outcome.reason).toContain(
    "trace serve",
  );
  expect(launchctl.calls).toEqual([]);
  expect(existsSync(join(home, "Library", "LaunchAgents"))).toBe(false);
});

test("an ephemeral npx executable is refused before anything is written", () => {
  const launchctl = fakeLaunchctl();

  const outcome = installConnectionService(
    env({
      TRACE_CLI_PATH: "/Users/x/.npm/_npx/abc123/node_modules/.bin/trace",
    }),
    dependencies(launchctl.run),
  );

  expect(outcome.kind).toBe("failed");
  expect(outcome.kind === "failed" && outcome.reason).toContain(
    "persistent global CLI",
  );
  expect(launchctl.calls).toEqual([]);
  expect(existsSync(resolveLaunchAgentPath(env()))).toBe(false);
});

test("a source-checkout executable is refused before anything is written", () => {
  const launchctl = fakeLaunchctl();

  const outcome = installConnectionService(
    env({ TRACE_CLI_PATH: "/Users/x/code/trace/apps/cli/src/trace.ts" }),
    dependencies(launchctl.run),
  );

  expect(outcome.kind).toBe("failed");
  expect(launchctl.calls).toEqual([]);
  expect(existsSync(resolveLaunchAgentPath(env()))).toBe(false);
});

test("a job launchd refuses to load says what landed and how to finish", () => {
  const launchctl = fakeLaunchctl((args) =>
    args[0] === "bootstrap"
      ? { status: 5, stderr: "Input/output error\n" }
      : notLoaded(args),
  );

  const outcome = installConnectionService(env(), dependencies(launchctl.run));

  expect(outcome.kind).toBe("failed");
  const reason = outcome.kind === "failed" ? outcome.reason : "";
  // The plist is on disk; only the load failed, so the recovery is the load.
  expect(existsSync(resolveLaunchAgentPath(env()))).toBe(true);
  expect(reason).toContain(resolveLaunchAgentPath(env()));
  expect(reason).toContain("launchctl bootstrap gui/501");
  expect(reason).toContain("Input/output error");
});

test("a job that loads but will not start reports the start failure", () => {
  const launchctl = fakeLaunchctl((args) =>
    args[0] === "kickstart"
      ? { status: 3, stderr: "No such process\n" }
      : notLoaded(args),
  );

  const outcome = installConnectionService(env(), dependencies(launchctl.run));

  expect(outcome.kind).toBe("failed");
  const reason = outcome.kind === "failed" ? outcome.reason : "";
  expect(reason).toContain("installed");
  expect(reason).toContain("launchctl kickstart");
});

test("without an injected launchd, a home that is not the login session's is left alone", () => {
  // The production path, from a fixture HOME: nothing may reach the real
  // launchd on this machine's behalf.
  const outcome = installConnectionService(env(), { platform: "darwin" });

  expect(outcome.kind).toBe("skipped");
  expect(existsSync(resolveLaunchAgentPath(env()))).toBe(false);
});

test("the connection's logs are bounded, rotated once, and owner-only", () => {
  const logs = resolveConnectionLogPaths(env());
  mkdirSync(logs.directory, { recursive: true, mode: 0o700 });
  writeFileSync(logs.out, "old ".repeat(600));
  writeFileSync(logs.error, "boom\n");

  rotateConnectionLogs(env(), { maxBytes: 1024 });

  // Over the cap: the live file starts empty and the previous run is kept once.
  expect(readFileSync(logs.out, "utf8")).toBe("");
  expect(readFileSync(`${logs.out}.1`, "utf8")).toContain("old");
  expect(statSync(logs.out).mode & 0o777).toBe(0o600);
  expect(statSync(`${logs.out}.1`).mode & 0o777).toBe(0o600);
  // Under the cap: left exactly as it was, and no rotation kept.
  expect(readFileSync(logs.error, "utf8")).toBe("boom\n");
  expect(existsSync(`${logs.error}.1`)).toBe(false);

  writeFileSync(logs.out, "new ".repeat(600));
  rotateConnectionLogs(env(), { maxBytes: 1024 });

  // A second rotation replaces the kept copy rather than accumulating.
  expect(readFileSync(`${logs.out}.1`, "utf8")).toContain("new");
  expect(existsSync(`${logs.out}.2`)).toBe(false);
});

test("a crashed connection is respawned by launchd, not by reinstalling", () => {
  installConnectionService(env(), dependencies(fakeLaunchctl(notLoaded).run));

  const parsed = parsePlist(resolveLaunchAgentPath(env()));
  if (!parsed) return;

  // Unconditional KeepAlive is what brings a *crashed* process back; the
  // conditional form would only respawn on a clean exit. The throttle is what
  // stops a job that crashes at startup from spinning.
  expect(parsed.KeepAlive).toBe(true);
  expect(parsed.ThrottleInterval).toBe(10);
});

test("the state of the installed service is read back from the plist launchd runs", () => {
  const awkward = join(home, "bin", "trace & <co>");
  installConnectionService(
    env({ TRACE_CLI_PATH: awkward }),
    dependencies(fakeLaunchctl(notLoaded).run),
  );

  const stopped = readConnectionServiceState(
    env(),
    dependencies(fakeLaunchctl(notLoaded).run),
  );
  const running = readConnectionServiceState(
    env(),
    dependencies(fakeLaunchctl().run),
  );

  expect(stopped).toMatchObject({ kind: "installed", loaded: false });
  // The path survives XML escaping intact, and its absence is what "stale"
  // means — the executable the job runs is gone.
  expect(running).toMatchObject({
    kind: "installed",
    loaded: true,
    cliPath: awkward,
    stale: true,
  });
});

test("nothing is installed, and nothing to read, before the first install", () => {
  expect(
    readConnectionServiceState(env(), dependencies(fakeLaunchctl().run)),
  ).toMatchObject({ kind: "missing" });
  expect(readInstalledConnectionCli(env())).toBeUndefined();
});
