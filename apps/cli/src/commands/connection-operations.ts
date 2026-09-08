import {
  openConnectionCredentials,
  type PairedBrowser,
} from "../connection-credentials.ts";
import {
  CONNECTION_ENDPOINT_ORIGIN,
  probeConnectionEndpoint,
  startManagedConnection,
  type EndpointOccupant,
  type ManagedConnectionDependencies,
} from "../connection-endpoint.ts";
import {
  describeConnectionServiceOutcome,
  installConnectionService,
  readConnectionServiceState,
  resolveConnectionLogPaths,
  restartConnectionService,
  rotateConnectionLogs,
  uninstallConnectionService,
  type ConnectionLifecycleOutcome,
  type ConnectionServiceDependencies,
  type ConnectionServiceState,
} from "../connection-service.ts";
import { openBrowser } from "../open-browser.ts";
import { failure, success, type CommandResult, type Env } from "./seam.ts";

/** Where the local connection always listens. */
const SERVICE_ORIGIN = CONNECTION_ENDPOINT_ORIGIN;

const NOT_RUNNING =
  "The Trace connection is not running. Start it with `trace serve`.";

export type ConnectionDependencies = ManagedConnectionDependencies & {
  /** Registers the graceful-shutdown handler. Injectable so tests never touch
   * this process's real signal handlers. */
  onShutdownSignal?: (shutDown: () => void) => void;
  /** launchd boundary for the login service, injected by tests. */
  service?: ConnectionServiceDependencies;
  /** Browser launch is injected in tests; pairing without --open only prints. */
  open?: (url: string) => void;
};

/**
 * `trace connection …` — the local administration commands. Each one asks the
 * *running* service over loopback rather than editing state behind its back, so
 * pairing and revocation take effect without a restart.
 */
export async function connectionOperation(
  args: string[],
  context: { env: Env },
  dependencies: ConnectionDependencies = { fetch: globalThis.fetch },
): Promise<CommandResult> {
  const [subcommand] = args;
  const request = managementRequest(context.env, dependencies);

  if (subcommand === "run") {
    return runManagedConnection(context.env, dependencies);
  }

  if (subcommand === "install") {
    return installLoginService(context.env, dependencies);
  }

  if (subcommand === "status") {
    return reportConnectionStatus(context.env, dependencies);
  }

  if (subcommand === "restart") {
    return reportLifecycle(
      restartConnectionService(context.env, dependencies.service),
    );
  }

  if (subcommand === "uninstall") {
    return reportLifecycle(
      uninstallConnectionService(context.env, dependencies.service),
    );
  }

  if (subcommand === "pair") {
    if (args.length === 2 && /^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$/.test(args[1]!)) {
      const code = args[1]!.toUpperCase();
      const response = await request(
        "POST",
        `/api/management/pairings/${code}/approve`,
      );
      if (!response.ok) {
        return failure(
          "This pairing code could not be approved. Get a fresh command from the page and check that Trace is running.",
        );
      }
      return success(
        "Browser approved. Return to the page—it will connect automatically.\n",
      );
    }
    if (args.slice(1).some((arg) => arg !== "--open")) {
      return failure("Usage: trace connection pair [<code>|--open]");
    }
    const response = await request("POST", "/api/management/pairings");
    if (!response.ok) return response.result;
    const link = response.payload as { url?: string };
    if (!link.url) {
      return failure(
        "No hosted board origin is configured, so there is nothing to pair with.",
      );
    }
    if (args.includes("--open")) {
      (dependencies.open ?? openBrowser)(link.url);
      return success(
        `Opening Trace in your browser.\nIf it did not open, use this link within 5 minutes:\n${link.url}\n`,
      );
    }
    return success(
      `Open this link in the browser you want to pair, within 5 minutes:\n${link.url}\n`,
    );
  }

  if (subcommand === "browsers") {
    const response = await request("GET", "/api/management/browsers");
    if (!response.ok) return response.result;
    const { browsers } = response.payload as { browsers: PairedBrowser[] };
    if (browsers.length === 0) {
      return success("No browsers are paired with this connection.\n");
    }
    return success(
      `${browsers
        .map(
          ({ id, label, pairedAt }) =>
            `${id}  ${label} — paired ${pairedAt.slice(0, 10)}`,
        )
        .join("\n")}\n`,
    );
  }

  if (subcommand === "revoke") {
    const id = args[1];
    if (!id) return failure("Usage: trace connection revoke <id>");
    const response = await request(
      "POST",
      `/api/management/browsers/${encodeURIComponent(id)}/revoke`,
    );
    if (!response.ok) return response.result;
    return success(`Revoked ${id}. That browser must pair again to connect.\n`);
  }

  if (subcommand === "reset") {
    const response = await request("POST", "/api/management/reset");
    if (!response.ok) return response.result;
    const { revoked } = response.payload as { revoked: number };
    return success(
      `Revoked ${revoked} paired ${revoked === 1 ? "browser" : "browsers"}. Local management access is unchanged.\n`,
    );
  }

  return failure(USAGE);
}

const USAGE =
  "Usage: trace connection <install|status|restart|uninstall|run|pair [<code>|--open]|browsers|revoke <id>|reset>";

/**
 * A lifecycle command is an explicit request, so every reason it did not
 * happen — including the ones `trace setup` passes over in silence — is an
 * error here.
 */
function reportLifecycle(outcome: ConnectionLifecycleOutcome): CommandResult {
  return outcome.kind === "ok"
    ? success(outcome.message)
    : failure(outcome.reason);
}

/**
 * `trace connection status` — one report of everything that decides whether
 * the board can reach this machine: what holds the endpoint, what launchd
 * thinks of the job, and where to read its logs. It only observes, so it
 * always succeeds; what it found is in the report, not the exit code.
 */
async function reportConnectionStatus(
  env: Env,
  dependencies: ConnectionDependencies,
): Promise<CommandResult> {
  const occupant = await probeConnectionEndpoint(env, dependencies);
  const state = readConnectionServiceState(env, dependencies.service);
  const logs = resolveConnectionLogPaths(env);

  const lines = [describeEndpoint(occupant), describeServiceState(state)];
  if (state.kind === "installed") {
    lines.push(`Logs: ${logs.out}`, `      ${logs.error}`);
  }
  return success(`${lines.join("\n")}\n`);
}

function describeEndpoint(occupant: EndpointOccupant): string {
  switch (occupant.kind) {
    case "own":
      return `Connection: running on ${SERVICE_ORIGIN} (Trace ${occupant.runtimeVersion}, pid ${occupant.pid}).`;
    case "free":
      return `Connection: not running — nothing is listening on ${SERVICE_ORIGIN}.`;
    case "incompatible":
      return (
        `Connection: a Trace ${occupant.runtimeVersion} runtime on ${SERVICE_ORIGIN} speaks protocol ${occupant.protocolVersion}, which this version does not.\n` +
        "  Recover with: trace connection restart"
      );
    case "foreign-trace":
      return (
        `Connection: another Trace installation holds ${SERVICE_ORIGIN}.\n` +
        "  Stop that connection before starting this one."
      );
    case "occupied":
      return (
        `Connection: another process is listening on ${SERVICE_ORIGIN}.\n` +
        "  Free that port, then run: trace connection restart"
      );
  }
}

function describeServiceState(state: ConnectionServiceState): string {
  switch (state.kind) {
    case "unsupported":
      return `Login service: ${state.reason}`;
    case "missing":
      return (
        "Login service: not installed.\n" +
        "  Install it with: trace connection install"
      );
    case "installed":
      if (state.stale) {
        return (
          `Login service: installed at ${state.plistPath}, but it runs ${state.cliPath}, which is no longer on disk.\n` +
          "  Recover with: trace connection install"
        );
      }
      return state.loaded
        ? `Login service: loaded from ${state.plistPath}.`
        : `Login service: installed at ${state.plistPath}, but launchd is not running it.\n` +
            "  Start it with: trace connection restart";
  }
}

/**
 * `trace connection install` — the deterministic path to a background
 * connection for someone who wants no agent integrations at all. `trace setup`
 * reconciles the same service; this is the same reconciliation on its own.
 */
function installLoginService(
  env: Env,
  dependencies: ConnectionDependencies,
): CommandResult {
  const outcome = installConnectionService(env, dependencies.service);
  const described = describeConnectionServiceOutcome(outcome);
  // An explicit install is a request, so every reason it did not happen is an
  // error here, including the ones `trace setup` passes over in silence.
  return outcome.kind === "installed" ||
    outcome.kind === "reconciled" ||
    outcome.kind === "unchanged"
    ? success(described)
    : failure(outcome.reason);
}

/**
 * `trace connection run` — the managed connection's own process, and what the
 * login service executes. It resolves once the endpoint is owned; the running
 * server is what keeps the process alive afterwards.
 */
async function runManagedConnection(
  env: Env,
  dependencies: ConnectionDependencies,
): Promise<CommandResult> {
  // launchd appends to the same log across every restart, so the moment
  // before this process starts writing is the one moment it can be bounded.
  rotateConnectionLogs(env);

  const outcome = await startManagedConnection(env, dependencies);

  if (outcome.kind === "conflict") return failure(outcome.reason);

  if (outcome.kind === "reused") {
    return success(
      `The Trace connection is already running on ${SERVICE_ORIGIN} (version ${outcome.runtimeVersion}, pid ${outcome.pid}).\n`,
    );
  }

  const { server } = outcome;
  (dependencies.onShutdownSignal ?? onProcessTermination)(() => {
    void server.close();
  });
  return success(`Trace connection listening on ${server.url}\n`);
}

/** launchd stops the service with SIGTERM; a developer running it in a
 * terminal uses SIGINT. Both mean: stop listening and let the process end. */
function onProcessTermination(shutDown: () => void): void {
  process.once("SIGTERM", shutDown);
  process.once("SIGINT", shutDown);
}

export type ManagementResponse =
  { ok: true; payload: unknown } | { ok: false; result: CommandResult };

/**
 * A caller for the local management surface, carrying this installation's
 * management credential. Exported so `trace board` can mint a pairing link
 * through the same authority rather than opening a second one.
 */
export function managementRequest(
  env: Env,
  { fetch }: Pick<ConnectionDependencies, "fetch">,
): (method: string, path: string) => Promise<ManagementResponse> {
  return async (method, path) => {
    let response: Response;
    try {
      response = await fetch(`${SERVICE_ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${openConnectionCredentials(env).managementToken}`,
        },
      });
    } catch {
      return { ok: false, result: failure(NOT_RUNNING) };
    }

    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        result: failure(
          response.status === 404 && body.startsWith("{")
            ? "No browser is paired with that id."
            : `The Trace connection refused the request (${response.status}).`,
        ),
      };
    }
    return { ok: true, payload: JSON.parse(body) as unknown };
  };
}
