import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TRACE_PROTOCOL_VERSION } from "@trace/core";
import { createPairingLinks } from "./bridge-pairing.ts";
import { openConnectionCredentials } from "./connection-credentials.ts";
import {
  probeConnectionEndpoint,
  startForegroundServe,
  startManagedConnection,
} from "./connection-endpoint.ts";
import { createServeRequestListener, DEFAULT_SERVE_PORT } from "./serve.ts";

let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trace-connection-endpoint-"));
  env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A `fetch` that behaves like nothing is listening on the endpoint. */
const refusing = (async () => {
  throw new TypeError("fetch failed");
}) as typeof globalThis.fetch;

test("the endpoint is free when nothing answers on 127.0.0.1:4317", async () => {
  const occupant = await probeConnectionEndpoint(env, { fetch: refusing });

  expect(occupant.kind).toBe("free");
});

/** A `fetch` that drives the real serve listener, so the probe is exercised
 * against the handler a running connection actually answers with. */
function runningService(
  options: { runtimeVersion?: string; home?: string } = {},
): {
  fetch: typeof globalThis.fetch;
} {
  const connection = openConnectionCredentials({
    ...env,
    HOME: options.home ?? home,
  });
  const listener = createServeRequestListener(
    join(home, "trace.sqlite"),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "https://trace-hosted.example",
    connection,
    createPairingLinks((label) => connection.issueBrowserToken(label)),
    options.runtimeVersion ?? "9.9.9",
  );
  return { fetch: fetchThrough(listener) };
}

function fetchThrough(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
): typeof globalThis.fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const captured = { statusCode: 200, body: "" };
    const res = {
      set statusCode(value: number) {
        captured.statusCode = value;
      },
      get statusCode() {
        return captured.statusCode;
      },
      setHeader: () => {},
      end: (chunk?: string) => {
        captured.body = chunk ?? "";
      },
    } as unknown as ServerResponse;
    const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
    Object.assign(req, {
      method: init?.method ?? "GET",
      url: url.pathname,
      headers: { host: url.host, ...(init?.headers as Record<string, string>) },
    });
    listener(req, res);
    return new Response(captured.body, { status: captured.statusCode });
  }) as typeof globalThis.fetch;
}

test("the endpoint is this installation when local management authorizes", async () => {
  const { fetch } = runningService({ runtimeVersion: "1.4.2" });

  const occupant = await probeConnectionEndpoint(env, { fetch });

  expect(occupant).toMatchObject({ kind: "own", runtimeVersion: "1.4.2" });
});

test("a Trace owned by another installation is reported as a conflict, not reused", async () => {
  const otherHome = mkdtempSync(join(tmpdir(), "trace-other-installation-"));
  try {
    const { fetch } = runningService({ home: otherHome });

    const occupant = await probeConnectionEndpoint(env, { fetch });

    expect(occupant.kind).toBe("foreign-trace");
  } finally {
    rmSync(otherHome, { recursive: true, force: true });
  }
});

test("an unrelated process on the port is reported as occupied", async () => {
  const fetch = (async () =>
    new Response("<html>someone else</html>", {
      status: 200,
    })) as typeof globalThis.fetch;

  const occupant = await probeConnectionEndpoint(env, { fetch });

  expect(occupant.kind).toBe("occupied");
});

test("our own runtime speaking another protocol is incompatible, not reusable", async () => {
  const { managementToken } = openConnectionCredentials(env);
  const fetch = (async (_input: string | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers?.authorization !== `Bearer ${managementToken}`) {
      return new Response("Local management authorization required", {
        status: 401,
      });
    }
    return new Response(
      JSON.stringify({
        service: "trace",
        protocolVersion: TRACE_PROTOCOL_VERSION + 1,
        runtimeVersion: "99.0.0",
        pid: 4242,
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;

  const occupant = await probeConnectionEndpoint(env, { fetch });

  expect(occupant).toMatchObject({
    kind: "incompatible",
    runtimeVersion: "99.0.0",
    protocolVersion: TRACE_PROTOCOL_VERSION + 1,
  });
});

test("an occupied endpoint is a reported conflict, never a killed process", async () => {
  const fetch = (async () =>
    new Response("not trace", { status: 200 })) as typeof globalThis.fetch;
  const start = vi.fn();

  const outcome = await startManagedConnection(env, { fetch, start });

  expect(outcome.kind).toBe("conflict");
  expect(start).not.toHaveBeenCalled();
});

test("a free endpoint starts the shared server strictly on the fixed port", async () => {
  const start = vi.fn(async () => fakeServer(DEFAULT_SERVE_PORT));

  const outcome = await startManagedConnection(env, { fetch: refusing, start });

  expect(outcome.kind).toBe("started");
  expect(start).toHaveBeenCalledWith(
    env,
    expect.objectContaining({
      port: DEFAULT_SERVE_PORT,
      allowPortFallback: false,
    }),
  );
});

function fakeServer(port: number) {
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: async () => {},
  };
}

test("a verified instance of this installation is reused, not started twice", async () => {
  const { fetch } = runningService({ runtimeVersion: "2.0.0" });
  const start = vi.fn();

  const outcome = await startManagedConnection(env, { fetch, start });

  expect(outcome).toMatchObject({ kind: "reused", runtimeVersion: "2.0.0" });
  expect(start).not.toHaveBeenCalled();
});

test("foreground serve leaves periodic sync to the managed connection", async () => {
  const { fetch } = runningService();
  const start = vi.fn(async () => fakeServer(DEFAULT_SERVE_PORT + 1));

  await startForegroundServe(env, { fetch, start });

  expect(start).toHaveBeenCalledWith(
    env,
    expect.objectContaining({ periodicSync: false }),
  );
});

test("foreground serve owns periodic sync when no managed connection runs", async () => {
  const start = vi.fn(async () => fakeServer(DEFAULT_SERVE_PORT));

  await startForegroundServe(env, { fetch: refusing, start });

  expect(start).toHaveBeenCalledWith(
    env,
    expect.not.objectContaining({ periodicSync: false }),
  );
});
