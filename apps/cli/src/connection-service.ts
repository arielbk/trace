import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkManagedCliPath, resolveTraceCliPath } from "./cli-path.ts";
import { CONNECTION_ENDPOINT_ORIGIN } from "./connection-endpoint.ts";
import { resolveAllowedWebOrigin } from "./serve.ts";

type Env = Record<string, string | undefined>;

/** The one launchd job Trace owns. Everything about the managed connection —
 * install, status, restart, uninstall — is addressed through this label. */
export const MANAGED_CONNECTION_LABEL = "com.arielbk.trace.connection";

/**
 * Seconds launchd waits before respawning the job. Ten is launchd's own
 * default: long enough that a crash loop cannot spin the CPU, short enough
 * that a real crash is invisible to someone reloading the board.
 */
const RESTART_THROTTLE_SECONDS = 10;

/** launchd starts login services with a bare environment, so the job carries
 * its own PATH rather than trusting whatever it is handed. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export type LaunchctlResult = { status: number | null; stderr: string };

export type ConnectionServiceDependencies = {
  /** Only darwin has launchd; everything else keeps foreground serve. */
  platform?: NodeJS.Platform;
  /** Runs `launchctl`. Injectable so tests never touch real launchd. */
  launchctl?: (args: string[]) => LaunchctlResult;
  /** The GUI domain the job is bootstrapped into — never a root domain. */
  uid?: number;
  /** The Node binary the job execs. Absolute, because there is no PATH yet. */
  nodePath?: string;
};

/** What installing the managed connection did, or why it did nothing. */
export type ConnectionServiceOutcome =
  /** The job was not loaded, and now is. */
  | { kind: "installed"; plistPath: string }
  /** The job was loaded against a stale plist, and was reloaded. */
  | { kind: "reconciled"; plistPath: string }
  /** The job was already loaded against this exact plist. */
  | { kind: "unchanged"; plistPath: string }
  /** No launchd here — the platform keeps its existing foreground story. */
  | { kind: "unsupported"; reason: string }
  /** No login session to install into — this run is pointed at some other
   * home, so there is nothing to reconcile and nothing worth saying about it. */
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/** `~/Library/LaunchAgents/com.arielbk.trace.connection.plist`. */
export function resolveLaunchAgentPath(env: Env): string {
  return join(
    userHome(env),
    "Library",
    "LaunchAgents",
    `${MANAGED_CONNECTION_LABEL}.plist`,
  );
}

/** Where the job's stdout and stderr land. */
export function resolveConnectionLogPaths(env: Env): {
  directory: string;
  out: string;
  error: string;
} {
  const directory = join(userHome(env), ".trace", "logs");
  return {
    directory,
    out: join(directory, "connection.log"),
    error: join(directory, "connection.error.log"),
  };
}

/**
 * Install — or reconcile — the per-user login service that runs the managed
 * connection. Idempotent: an unchanged plist against a loaded job is left
 * alone, so running `trace setup` twice does not restart a healthy connection.
 * It never installs a root or system daemon, and never touches a job that is
 * not {@link MANAGED_CONNECTION_LABEL}.
 */
export function installConnectionService(
  env: Env,
  dependencies: ConnectionServiceDependencies = {},
): ConnectionServiceOutcome {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      kind: "unsupported",
      reason:
        `A managed background connection needs launchd, which ${platform} does not have.\n` +
        `  Run \`trace serve\` to connect a board on this machine.`,
    };
  }

  // launchd's `gui/<uid>` domain belongs to the logged-in user, whose home is
  // `homedir()`. A run pointed at some other HOME — a test fixture, a sandbox —
  // has no login session to install into, and must never reach the real
  // launchd on its behalf. Only an injected boundary crosses that line.
  if (!dependencies.launchctl && userHome(env) !== homedir()) {
    return {
      kind: "skipped",
      reason:
        `A managed background connection installs into this login session's home ` +
        `(${homedir()}), but HOME points at ${userHome(env)}.\n` +
        `  Run \`trace serve\` to connect a board from here.`,
    };
  }

  const cliPath = resolveTraceCliPath(env, platform);
  const usable = checkManagedCliPath(cliPath);
  if (!usable.ok) return { kind: "failed", reason: usable.error };

  const launchctl = dependencies.launchctl ?? runLaunchctl;
  const uid = dependencies.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const target = `${domain}/${MANAGED_CONNECTION_LABEL}`;

  const plistPath = resolveLaunchAgentPath(env);
  const desired = renderLaunchAgentPlist({
    env,
    cliPath,
    nodePath: dependencies.nodePath ?? process.execPath,
  });
  const current = existsSync(plistPath)
    ? readFileSync(plistPath, "utf8")
    : undefined;

  const loaded = launchctl(["print", target]).status === 0;
  if (loaded && current === desired) return { kind: "unchanged", plistPath };

  // The log directory has to exist before launchd opens the job's streams in
  // it, and it holds this installation's own diagnostics, so it is owner-only.
  mkdirSync(resolveConnectionLogPaths(env).directory, {
    recursive: true,
    mode: 0o700,
  });
  if (current !== desired) writePlist(plistPath, desired);

  // A loaded job holds the old plist until it is booted out; launchd will not
  // replace it in place. An unloaded one has nothing to remove, and booting it
  // out would report a failure that is not one.
  if (loaded) launchctl(["bootout", target]);

  const bootstrapped = launchctl(["bootstrap", domain, plistPath]);
  if (bootstrapped.status !== 0) {
    return {
      kind: "failed",
      reason:
        `The login service was written to ${plistPath}, but launchd would not load it:\n` +
        `${indent(bootstrapped.stderr)}\n` +
        `  Recover with: launchctl bootstrap ${domain} ${plistPath}`,
    };
  }

  const started = launchctl(["kickstart", "-k", target]);
  if (started.status !== 0) {
    return {
      kind: "failed",
      reason:
        `The login service is installed at ${plistPath}, but would not start:\n` +
        `${indent(started.stderr)}\n` +
        `  Recover with: launchctl kickstart -k ${target}`,
    };
  }

  return { kind: loaded ? "reconciled" : "installed", plistPath };
}

/** One line of human-readable outcome, for setup summaries and the command. */
export function describeConnectionServiceOutcome(
  outcome: ConnectionServiceOutcome,
): string {
  switch (outcome.kind) {
    case "installed":
      return `Local connection installed as a login service; it starts at login on ${CONNECTION_ENDPOINT_ORIGIN}.\n`;
    case "reconciled":
      return `Local connection reconciled onto this version and restarted on ${CONNECTION_ENDPOINT_ORIGIN}.\n`;
    case "unchanged":
      return `Local connection is already installed and running on ${CONNECTION_ENDPOINT_ORIGIN}.\n`;
    case "unsupported":
      return `Local connection: ${outcome.reason}\n`;
    // Not a limitation of this machine, just of this invocation: setup has
    // nothing useful to tell anyone about it.
    case "skipped":
      return "";
    case "failed":
      return `⚠ The local connection was not installed.\n${outcome.reason}\n`;
  }
}

/**
 * Renders the LaunchAgent. Every path in it is absolute and every variable the
 * connection needs is written in, because a login service inherits neither a
 * shell nor the interactive environment that configured it.
 */
export function renderLaunchAgentPlist(options: {
  env: Env;
  cliPath: string;
  nodePath: string;
}): string {
  const { env, cliPath, nodePath } = options;
  const logs = resolveConnectionLogPaths(env);
  const home = userHome(env);

  const environment: Record<string, string> = {
    HOME: home,
    PATH: `${dirname(nodePath)}:${SYSTEM_PATH}`,
  };
  // Only an origin the API would actually honor is worth persisting; anything
  // else would bake a value into the job that the running server rejects.
  const hostedOrigin = resolveAllowedWebOrigin(env);
  if (hostedOrigin) environment.TRACE_WEB_ORIGIN = hostedOrigin;

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(MANAGED_CONNECTION_LABEL)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[nodePath, cliPath, "connection", "run"].map(
      (argument) => `    <string>${escapeXml(argument)}</string>`,
    ),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(environment).flatMap(([key, value]) => [
      `    <key>${escapeXml(key)}</key>`,
      `    <string>${escapeXml(value)}</string>`,
    ]),
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(home)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>${RESTART_THROTTLE_SECONDS}</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(logs.out)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(logs.error)}</string>`,
    `</dict>`,
    `</plist>`,
  ];
  return `${lines.join("\n")}\n`;
}

function userHome(env: Env): string {
  return env.HOME ?? homedir();
}

/** Writes the job atomically, so launchd never reads a half-written plist. */
function writePlist(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.trace-tmp-${process.pid}`;
  writeFileSync(temporary, contents, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, path);
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function indent(detail: string): string {
  const trimmed = detail.trim() || "launchctl reported no detail.";
  return trimmed
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
