import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkManagedCliPath, resolveTraceCliPath } from "./cli-path.ts";
import { openConnectionCredentials } from "./connection-credentials.ts";
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
 * How large a log may grow before the previous run is set aside. launchd
 * appends to the same file across every restart for the life of the install,
 * so without a bound it grows without one.
 */
const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Bound the connection's logs by keeping at most one previous copy of each.
 * Called as the managed connection starts, which is the only moment nothing is
 * mid-write. Both the live file and the kept copy are owner-only: they are
 * this installation's own diagnostics.
 */
export function rotateConnectionLogs(
  env: Env,
  options: { maxBytes?: number } = {},
): void {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const logs = resolveConnectionLogPaths(env);
  for (const path of [logs.out, logs.error]) {
    if (!existsSync(path) || statSync(path).size <= maxBytes) continue;
    // One kept copy, replaced each time: bounded by construction, and enough
    // to read what a crashing job said before it was restarted.
    renameSync(path, `${path}.1`);
    chmodSync(`${path}.1`, 0o600);
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
  }
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
    return { kind: "unsupported", reason: unsupportedReason(platform) };
  }

  // launchd's `gui/<uid>` domain belongs to the logged-in user, whose home is
  // `homedir()`. A run pointed at some other HOME — a test fixture, a sandbox —
  // has no login session to install into, and must never reach the real
  // launchd on its behalf. Only an injected boundary crosses that line.
  if (!dependencies.launchctl && userHome(env) !== homedir()) {
    return { kind: "skipped", reason: foreignHomeReason(env) };
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

/** What a lifecycle command (restart, uninstall) did, or why it did not. */
export type ConnectionLifecycleOutcome =
  | { kind: "ok"; message: string }
  | { kind: "unsupported"; reason: string }
  /** Pointed at some other home, so there is no login session to act on. */
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * Restart the managed connection onto whatever executable the plist now names
 * — the upgrade path as much as the recovery one, since a package manager can
 * replace the CLI in place and leave the old process running. It only ever
 * addresses {@link MANAGED_CONNECTION_LABEL}, and never touches the credential
 * store, so browsers paired before the restart stay paired.
 */
export function restartConnectionService(
  env: Env,
  dependencies: ConnectionServiceDependencies = {},
): ConnectionLifecycleOutcome {
  const guard = guardLifecycle(env, dependencies);
  if (guard) return guard;

  const state = readConnectionServiceState(env, dependencies);
  if (state.kind !== "installed") {
    // `readConnectionServiceState` shares this file's platform guard, so the
    // only remaining kind here is `missing`.
    return {
      kind: "failed",
      reason:
        "No Trace login service is installed, so there is nothing to restart.\n" +
        "  Install it with: trace connection install",
    };
  }

  const launchctl = dependencies.launchctl ?? runLaunchctl;
  const uid = dependencies.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const target = `${domain}/${MANAGED_CONNECTION_LABEL}`;

  // launchd cannot kickstart a job it is not holding, so an unloaded one is
  // bootstrapped back in first.
  if (!state.loaded) {
    const bootstrapped = launchctl(["bootstrap", domain, state.plistPath]);
    if (bootstrapped.status !== 0) {
      return {
        kind: "failed",
        reason:
          `launchd would not load ${state.plistPath}:\n` +
          `${indent(bootstrapped.stderr)}\n` +
          `  Recover with: launchctl bootstrap ${domain} ${state.plistPath}`,
      };
    }
  }

  const started = launchctl(["kickstart", "-k", target]);
  if (started.status !== 0) {
    return {
      kind: "failed",
      reason:
        `The login service is installed, but would not restart:\n` +
        `${indent(started.stderr)}\n` +
        `  Recover with: launchctl kickstart -k ${target}`,
    };
  }

  return {
    kind: "ok",
    message: `Local connection restarted on ${CONNECTION_ENDPOINT_ORIGIN}. Paired browsers are unchanged.\n`,
  };
}

/**
 * Remove the managed connection: stop and forget the launchd job, delete its
 * plist, and revoke every paired browser so nothing can reach this machine
 * afterwards. Idempotent — running it twice is a no-op the second time — and
 * deliberately narrow: the task database, its documents, the agent
 * integrations, and local management access all survive.
 */
export function uninstallConnectionService(
  env: Env,
  dependencies: ConnectionServiceDependencies = {},
): ConnectionLifecycleOutcome {
  const guard = guardLifecycle(env, dependencies);
  if (guard) return guard;

  const state = readConnectionServiceState(env, dependencies);
  const launchctl = dependencies.launchctl ?? runLaunchctl;
  const uid = dependencies.uid ?? process.getuid?.() ?? 0;
  const target = `gui/${uid}/${MANAGED_CONNECTION_LABEL}`;

  // Booting out an unloaded job reports a failure that is not one, so only a
  // job launchd is actually holding is stopped.
  const stopped =
    state.kind === "installed" && state.loaded
      ? launchctl(["bootout", target])
      : { status: 0, stderr: "" };

  if (state.kind === "installed") rmSync(state.plistPath, { force: true });

  // Revoked whether or not a service was installed: nobody should keep browser
  // access to a connection that is being removed.
  const credentials = openConnectionCredentials(env);
  const revoked = credentials.listBrowsers().length;
  credentials.reset();

  const removedBrowsers = `${revoked} paired ${revoked === 1 ? "browser" : "browsers"} revoked`;

  if (stopped.status !== 0) {
    return {
      kind: "failed",
      reason:
        `The login service plist was removed and ${removedBrowsers}, but launchd would not stop the running job:\n` +
        `${indent(stopped.stderr)}\n` +
        `  Recover with: launchctl bootout ${target}`,
    };
  }

  return {
    kind: "ok",
    message:
      state.kind === "installed"
        ? `Local connection uninstalled: login service removed, ${removedBrowsers}.\n` +
          `Your tasks, documents and agent integrations are unchanged.\n`
        : `No Trace login service is installed; ${removedBrowsers}.\n`,
  };
}

/**
 * The two reasons a lifecycle command must not reach launchd at all: a
 * platform without it, and a run pointed at a home that is not this login
 * session's. Only an injected boundary crosses the second.
 */
function guardLifecycle(
  env: Env,
  dependencies: ConnectionServiceDependencies,
): ConnectionLifecycleOutcome | undefined {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") {
    return { kind: "unsupported", reason: unsupportedReason(platform) };
  }
  if (!dependencies.launchctl && userHome(env) !== homedir()) {
    return { kind: "skipped", reason: foreignHomeReason(env) };
  }
  return undefined;
}

/** What the installed login service looks like right now, read without
 * changing anything. */
export type ConnectionServiceState =
  /** No launchd here, so there is no service to describe. */
  | { kind: "unsupported"; reason: string }
  /** Nothing has been installed under {@link MANAGED_CONNECTION_LABEL}. */
  | { kind: "missing"; plistPath: string }
  | {
      /** Installed, and whether launchd currently holds the job. */
      kind: "installed";
      plistPath: string;
      loaded: boolean;
      /** The executable the job runs, as recorded in the plist. */
      cliPath?: string;
      /** True when that executable is no longer on disk — an uninstall or a
       * package manager moved out from under the job. */
      stale: boolean;
    };

/**
 * Read the state of the installed login service. Purely observational: it
 * runs `launchctl print` and reads the plist, and never loads, unloads, or
 * rewrites anything.
 */
export function readConnectionServiceState(
  env: Env,
  dependencies: ConnectionServiceDependencies = {},
): ConnectionServiceState {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") {
    return { kind: "unsupported", reason: unsupportedReason(platform) };
  }

  const plistPath = resolveLaunchAgentPath(env);
  if (!existsSync(plistPath)) return { kind: "missing", plistPath };

  const cliPath = readPlistCliPath(readFileSync(plistPath, "utf8"));
  const launchctl = dependencies.launchctl ?? runLaunchctl;
  const uid = dependencies.uid ?? process.getuid?.() ?? 0;
  const loaded =
    launchctl(["print", `gui/${uid}/${MANAGED_CONNECTION_LABEL}`]).status === 0;

  return {
    kind: "installed",
    plistPath,
    loaded,
    ...(cliPath ? { cliPath } : {}),
    stale: cliPath !== undefined && !existsSync(cliPath),
  };
}

/**
 * The executable the installed login service runs, or undefined when none is
 * installed. Reads only the plist — no launchd call — so update paths can ask
 * whether this machine has a managed connection without touching launchd.
 */
export function readInstalledConnectionCli(env: Env): string | undefined {
  const plistPath = resolveLaunchAgentPath(env);
  if (!existsSync(plistPath)) return undefined;
  return readPlistCliPath(readFileSync(plistPath, "utf8"));
}

/**
 * The Trace executable a rendered plist runs. The job's arguments are
 * `<node> <cli> connection run`, so the CLI is the argument before
 * `connection`.
 */
export function readPlistCliPath(plist: string): string | undefined {
  const args = plist
    .split("<key>ProgramArguments</key>", 2)[1]
    ?.split("</array>", 1)[0];
  if (!args) return undefined;
  const strings = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map(
    (match) => unescapeXml(match[1] as string),
  );
  const runs = strings.indexOf("connection");
  return runs > 0 ? strings[runs - 1] : undefined;
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

function foreignHomeReason(env: Env): string {
  return (
    `A managed background connection lives in this login session's home ` +
    `(${homedir()}), but HOME points at ${userHome(env)}.\n` +
    `  Run \`trace serve\` to connect a board from here.`
  );
}

function unsupportedReason(platform: NodeJS.Platform): string {
  return (
    `A managed background connection needs launchd, which ${platform} does not have.\n` +
    `  Run \`trace serve\` to connect a board on this machine.`
  );
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

function unescapeXml(value: string): string {
  return value
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
