import {
  openConnectionCredentials,
  type PairedBrowser,
} from "../connection-credentials.ts";
import {
  CONNECTION_ENDPOINT_ORIGIN,
  startManagedConnection,
  type ManagedConnectionDependencies,
} from "../connection-endpoint.ts";
import { failure, success, type CommandResult, type Env } from "./seam.ts";

/** Where the local connection always listens. */
const SERVICE_ORIGIN = CONNECTION_ENDPOINT_ORIGIN;

const NOT_RUNNING =
  "The Trace connection is not running. Start it with `trace serve`.";

export type ConnectionDependencies = ManagedConnectionDependencies & {
  /** Registers the graceful-shutdown handler. Injectable so tests never touch
   * this process's real signal handlers. */
  onShutdownSignal?: (shutDown: () => void) => void;
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

  if (subcommand === "pair") {
    const response = await request("POST", "/api/management/pairings");
    if (!response.ok) return response.result;
    const link = response.payload as { url?: string };
    if (!link.url) {
      return failure(
        "No hosted board origin is configured, so there is nothing to pair with.",
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

  return failure(
    "Usage: trace connection <run|pair|browsers|revoke <id>|reset>",
  );
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

type ManagementResponse =
  | { ok: true; payload: unknown }
  | { ok: false; result: CommandResult };

function managementRequest(
  env: Env,
  { fetch }: ConnectionDependencies,
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
