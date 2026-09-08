import { TRACE_PROTOCOL_VERSION } from "@trace/core";
import { openConnectionCredentials } from "./connection-credentials.ts";
import {
  DEFAULT_SERVE_PORT,
  startTraceServe,
  type StartTraceServeOptions,
  type TraceServer,
} from "./serve.ts";

type Env = Record<string, string | undefined>;

/**
 * The one address the managed connection ever listens on. Hosted boards are
 * configured against it, so the managed runtime never moves to another port:
 * it either owns this endpoint or reports what is holding it.
 */
export const CONNECTION_ENDPOINT_ORIGIN = `http://127.0.0.1:${DEFAULT_SERVE_PORT}`;

/** What is currently holding {@link CONNECTION_ENDPOINT_ORIGIN}. */
export type EndpointOccupant =
  | { kind: "free" }
  | {
      kind: "own";
      runtimeVersion: string;
      protocolVersion: number;
      pid: number;
    }
  /** Ours, but speaking a protocol this CLI does not — an upgrade landed
   * half-way, so the running process must be replaced rather than reused. */
  | { kind: "incompatible"; runtimeVersion: string; protocolVersion: number }
  /** A Trace runtime that will not accept this installation's management
   * credential — another user's or another checkout's connection. */
  | { kind: "foreign-trace" }
  /** Something is listening that is not a Trace connection at all. */
  | { kind: "occupied" };

export type EndpointDependencies = {
  fetch: typeof globalThis.fetch;
};

export type ManagedConnectionDependencies = EndpointDependencies & {
  /** Injectable so tests never bind a real socket. */
  start?: (env: Env, options: StartTraceServeOptions) => Promise<TraceServer>;
};

/** What happened when the managed connection tried to take the endpoint. */
export type ManagedConnectionOutcome =
  | { kind: "started"; server: TraceServer }
  | { kind: "reused"; runtimeVersion: string; pid: number }
  | { kind: "conflict"; reason: string };

/**
 * Take ownership of {@link CONNECTION_ENDPOINT_ORIGIN} for the managed
 * connection: reuse a verified instance of this installation, start one when
 * the endpoint is free, and otherwise say what is in the way. It never falls
 * back to another port (the hosted board is configured against this one) and
 * never terminates whatever it finds.
 */
export async function startManagedConnection(
  env: Env,
  dependencies: ManagedConnectionDependencies,
): Promise<ManagedConnectionOutcome> {
  const occupant = await probeConnectionEndpoint(env, dependencies);

  if (occupant.kind === "own") {
    return {
      kind: "reused",
      runtimeVersion: occupant.runtimeVersion,
      pid: occupant.pid,
    };
  }
  if (occupant.kind === "foreign-trace") {
    return {
      kind: "conflict",
      reason: `Another Trace installation is already using ${CONNECTION_ENDPOINT_ORIGIN}.`,
    };
  }
  if (occupant.kind === "incompatible") {
    return {
      kind: "conflict",
      reason: `A Trace ${occupant.runtimeVersion} runtime speaking protocol ${occupant.protocolVersion} holds ${CONNECTION_ENDPOINT_ORIGIN}. Restart the connection to pick up this version.`,
    };
  }
  if (occupant.kind === "occupied") {
    return {
      kind: "conflict",
      reason: `Another process is listening on ${CONNECTION_ENDPOINT_ORIGIN}. Free that port, then start the connection again.`,
    };
  }

  const start = dependencies.start ?? startTraceServe;
  try {
    return {
      kind: "started",
      server: await start(env, {
        port: DEFAULT_SERVE_PORT,
        allowPortFallback: false,
      }),
    };
  } catch (error) {
    return {
      kind: "conflict",
      reason: `The connection could not take ${CONNECTION_ENDPOINT_ORIGIN}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Ask the endpoint who is there, and never mutate anything on the way. A
 * public handshake is not proof of ownership — anyone's Trace answers it — so
 * ownership is decided by whether the process accepts *this* installation's
 * local management credential.
 */
export async function probeConnectionEndpoint(
  env: Env,
  { fetch }: EndpointDependencies,
): Promise<EndpointOccupant> {
  let response: Response;
  try {
    response = await fetch(
      `${CONNECTION_ENDPOINT_ORIGIN}/api/management/status`,
      {
        headers: {
          authorization: `Bearer ${openConnectionCredentials(env).managementToken}`,
        },
      },
    );
  } catch {
    return { kind: "free" };
  }

  const status = await readJson(response);
  if (
    response.ok &&
    status?.service === "trace" &&
    typeof status.runtimeVersion === "string" &&
    typeof status.protocolVersion === "number"
  ) {
    return status.protocolVersion === TRACE_PROTOCOL_VERSION
      ? {
          kind: "own",
          runtimeVersion: status.runtimeVersion,
          protocolVersion: status.protocolVersion,
          pid: typeof status.pid === "number" ? status.pid : 0,
        }
      : {
          kind: "incompatible",
          runtimeVersion: status.runtimeVersion,
          protocolVersion: status.protocolVersion,
        };
  }

  return (await identifiesAsTrace(fetch))
    ? { kind: "foreign-trace" }
    : { kind: "occupied" };
}

/**
 * `trace serve` — the explicit foreground runtime, kept for development and
 * troubleshooting. It still moves to a free port when the endpoint is taken,
 * but it hands periodic sync to the managed connection when one is running, so
 * two coexisting runtimes never sync twice as often as one.
 */
export async function startForegroundServe(
  env: Env,
  dependencies: ManagedConnectionDependencies,
): Promise<TraceServer> {
  const occupant = await probeConnectionEndpoint(env, dependencies);
  const start = dependencies.start ?? startTraceServe;
  return start(env, occupant.kind === "own" ? { periodicSync: false } : {});
}

/** The public handshake: enough to name what is listening, never enough to
 * claim it. */
async function identifiesAsTrace(
  fetch: typeof globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${CONNECTION_ENDPOINT_ORIGIN}/api/connection`,
    );
    return (await readJson(response))?.service === "trace";
  } catch {
    return false;
  }
}

async function readJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
