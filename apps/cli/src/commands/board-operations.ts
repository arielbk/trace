import {
  CONNECTION_ENDPOINT_ORIGIN,
  probeConnectionEndpoint,
  startForegroundServe,
  type EndpointOccupant,
  type ManagedConnectionDependencies,
} from "../connection-endpoint.ts";
import { openBrowser } from "../open-browser.ts";
import { resolveAllowedWebOrigin } from "../serve.ts";
import { managementRequest } from "./connection-operations.ts";
import { failure, success, type CommandResult, type Env } from "./seam.ts";

export type BoardDependencies = ManagedConnectionDependencies & {
  /** Injectable browser launch, so tests never open a window. */
  open?: (url: string) => void;
};

const USAGE = "Usage: eqnx board [--local]";

/**
 * `eqnx board` — the ordinary way to open the board. With a hosted origin
 * configured it hands the browser a fresh, single-use pairing link against the
 * connection that is already running; without one — or with `--local` — it
 * opens the board EQNX bundles with itself.
 */
export async function boardOperation(
  args: string[],
  context: { env: Env },
  dependencies: BoardDependencies = { fetch: globalThis.fetch },
): Promise<CommandResult> {
  const unknown = args.find((argument) => argument !== "--local");
  if (unknown) return failure(`Unknown option ${unknown}\n${USAGE}`);

  const { env } = context;
  const hostedOrigin = resolveAllowedWebOrigin(env);
  const occupant = await probeConnectionEndpoint(env, dependencies);

  return args.includes("--local") || !hostedOrigin
    ? openBundledBoard(env, occupant, dependencies)
    : openHostedBoard(env, hostedOrigin, occupant, dependencies);
}

/**
 * The hosted board reads this machine through the managed connection, so there
 * is nothing to open until that connection is the one holding the endpoint.
 * Every other occupant is reported with the command that resolves it rather
 * than papered over with a local board the viewer did not ask for.
 */
async function openHostedBoard(
  env: Env,
  hostedOrigin: string,
  occupant: EndpointOccupant,
  dependencies: BoardDependencies,
): Promise<CommandResult> {
  if (occupant.kind !== "own") {
    return failure(`${describeUnusable(occupant)}\n${LOCAL_INSTEAD}`);
  }

  // Minting the link through the running service is what lets a second browser
  // in without a restart: the process keeps the link, and pairing it mints that
  // browser its own credential.
  const response = await managementRequest(
    env,
    dependencies,
  )("POST", "/api/management/pairings");
  if (!response.ok) return response.result;

  const { url } = response.payload as { url?: string };
  if (!url) {
    return failure(
      `The EQNX connection is running, but it was not started with ${hostedOrigin} configured.\n` +
        "Reinstall it with: eqnx connection install",
    );
  }

  (dependencies.open ?? openBrowser)(url);
  return success(
    `Opening the EQNX board at ${hostedOrigin}.\n` +
      `If it did not open, use this link within 5 minutes:\n${url}\n`,
  );
}

/**
 * The board EQNX ships with itself, served from this machine. A managed
 * connection already serving the endpoint is reused as it stands — opening the
 * board is never a reason to run a second runtime.
 */
async function openBundledBoard(
  env: Env,
  occupant: EndpointOccupant,
  dependencies: BoardDependencies,
): Promise<CommandResult> {
  const open = dependencies.open ?? openBrowser;

  if (occupant.kind === "own") {
    const url = `${CONNECTION_ENDPOINT_ORIGIN}/`;
    open(url);
    return success(`Opening the EQNX board at ${url}\n`);
  }

  try {
    // Foreground serve moves to a free port when something else holds the
    // endpoint, so an occupied 4317 still produces a board.
    const server = await startForegroundServe(env, dependencies);
    open(server.url);
    return success(
      `EQNX board listening on ${server.url}\nStop it with Ctrl-C.\n`,
    );
  } catch (error) {
    return failure(
      `The EQNX board could not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const LOCAL_INSTEAD =
  "Open the board EQNX bundles with itself instead: eqnx board --local";

/** Why the hosted board has nothing to connect to, and what fixes it. */
function describeUnusable(occupant: EndpointOccupant): string {
  switch (occupant.kind) {
    case "free":
      return (
        `The EQNX connection is not running on ${CONNECTION_ENDPOINT_ORIGIN}, so the hosted board has nothing to read.\n` +
        "Start it with: eqnx connection install"
      );
    case "incompatible":
      return (
        `A EQNX ${occupant.runtimeVersion} runtime speaking protocol ${occupant.protocolVersion} holds ${CONNECTION_ENDPOINT_ORIGIN}.\n` +
        "Move it onto this version with: eqnx connection restart"
      );
    case "foreign-trace":
      return (
        `Another EQNX installation holds ${CONNECTION_ENDPOINT_ORIGIN}, so this one cannot answer the hosted board.\n` +
        "Stop that connection, then run: eqnx connection restart"
      );
    default:
      return (
        `Another process is listening on ${CONNECTION_ENDPOINT_ORIGIN}, so the hosted board cannot reach EQNX.\n` +
        "Free that port, then run: eqnx connection restart"
      );
  }
}
