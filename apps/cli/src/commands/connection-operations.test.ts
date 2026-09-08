import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPairingLinks } from "../bridge-pairing.ts";
import { openConnectionCredentials } from "../connection-credentials.ts";
import { CONNECTION_ENDPOINT_ORIGIN } from "../connection-endpoint.ts";
import {
  MANAGED_CONNECTION_LABEL,
  type ConnectionServiceDependencies,
} from "../connection-service.ts";
import { createServeRequestListener, DEFAULT_SERVE_PORT } from "../serve.ts";
import { connectionOperation } from "./connection-operations.ts";

let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trace-connection-command-"));
  env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A `fetch` that drives the real serve listener, so these tests exercise the
 * command against the handler it talks to in production. */
function runningService(): {
  fetch: typeof globalThis.fetch;
  connection: ReturnType<typeof openConnectionCredentials>;
} {
  const connection = openConnectionCredentials(env);
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
  );

  const fetch = (async (input: string | URL, init?: RequestInit) => {
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

  return { fetch, connection };
}

test("trace connection pair prints a single-use link for another browser", async () => {
  const { fetch } = runningService();

  const result = await connectionOperation(["pair"], { env }, { fetch });

  expect(result.exitCode).toBe(0);
  const link = result.stdout.match(
    /https:\/\/trace-hosted\.example\/#trace-pair=[A-Za-z0-9_-]{43}/,
  );
  expect(link).not.toBeNull();
  // The link is the secret; the local management credential never is.
  expect(result.stdout).not.toContain(
    openConnectionCredentials(env).managementToken,
  );
});

test("trace connection pair says how to start a connection that is not running", async () => {
  const fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;

  const result = await connectionOperation(["pair"], { env }, { fetch });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("not running");
});

test("trace connection browsers lists what is paired and revoke removes one", async () => {
  const { fetch, connection } = runningService();
  const laptop = connection.issueBrowserToken("Safari");
  const phone = connection.issueBrowserToken("Chrome");

  const listed = await connectionOperation(["browsers"], { env }, { fetch });
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout).toContain(laptop.id);
  expect(listed.stdout).toContain(phone.id);
  expect(listed.stdout).toContain("Safari");
  expect(listed.stdout).not.toContain(laptop.token);

  const revoked = await connectionOperation(
    ["revoke", phone.id],
    { env },
    { fetch },
  );
  expect(revoked.exitCode).toBe(0);
  expect(revoked.stdout).toContain(phone.id);
  expect(connection.verifyBrowserToken(phone.token)).toBeNull();
  expect(connection.verifyBrowserToken(laptop.token)).not.toBeNull();

  const missing = await connectionOperation(
    ["revoke", "never-paired"],
    { env },
    { fetch },
  );
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr).toContain("No browser is paired");
});

test("trace connection reset revokes every browser at once", async () => {
  const { fetch, connection } = runningService();
  const laptop = connection.issueBrowserToken("Safari");
  connection.issueBrowserToken("Chrome");

  const reset = await connectionOperation(["reset"], { env }, { fetch });

  expect(reset.exitCode).toBe(0);
  expect(reset.stdout).toContain("2");
  expect(connection.verifyBrowserToken(laptop.token)).toBeNull();
  expect(
    (await connectionOperation(["browsers"], { env }, { fetch })).stdout,
  ).toContain("No browsers are paired");
});

test("trace connection needs a subcommand it recognises", async () => {
  const { fetch } = runningService();

  const result = await connectionOperation(["frobnicate"], { env }, { fetch });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Usage: trace connection");
});

test("trace connection run takes the fixed endpoint and says where it listens", async () => {
  const closed = { count: 0 };
  const start = async () => ({
    url: `${CONNECTION_ENDPOINT_ORIGIN}/`,
    port: DEFAULT_SERVE_PORT,
    close: async () => {
      closed.count += 1;
    },
  });

  const result = await connectionOperation(
    ["run"],
    { env },
    { fetch: refusing, start },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(CONNECTION_ENDPOINT_ORIGIN);
});

/** A `fetch` that behaves like nothing is listening on the endpoint. */
const refusing = (async () => {
  throw new TypeError("fetch failed");
}) as typeof globalThis.fetch;

test("a shutdown signal closes the connection's server", async () => {
  const closed = { count: 0 };
  const start = async () => ({
    url: `${CONNECTION_ENDPOINT_ORIGIN}/`,
    port: DEFAULT_SERVE_PORT,
    close: async () => {
      closed.count += 1;
    },
  });
  let shutDown = (): void => {};

  await connectionOperation(
    ["run"],
    { env },
    {
      fetch: refusing,
      start,
      onShutdownSignal: (handler) => {
        shutDown = handler;
      },
    },
  );
  expect(closed.count).toBe(0);

  shutDown();
  await vi.waitFor(() => expect(closed.count).toBe(1));
});

test("trace connection run reports a busy endpoint instead of taking it", async () => {
  const fetch = (async () =>
    new Response("not trace", { status: 200 })) as typeof globalThis.fetch;
  const start = vi.fn();

  const result = await connectionOperation(["run"], { env }, { fetch, start });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(CONNECTION_ENDPOINT_ORIGIN);
  expect(start).not.toHaveBeenCalled();
});

test("trace connection run reuses the connection already running here", async () => {
  const { fetch } = runningService();
  const start = vi.fn();

  const result = await connectionOperation(["run"], { env }, { fetch, start });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("already running");
  expect(start).not.toHaveBeenCalled();
});

/** Records launchctl instead of touching real launchd. */
function fakeLaunchd(
  answer: (args: string[]) => { status: number | null; stderr: string } = (
    args,
  ) =>
    args[0] === "print"
      ? { status: 113, stderr: "Could not find service\n" }
      : { status: 0, stderr: "" },
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

test("trace connection install starts the login service without any integration", async () => {
  const { calls, service } = fakeLaunchd();

  const result = await connectionOperation(
    ["install"],
    { env: { ...env, TRACE_CLI_PATH: "/opt/global/bin/trace" } },
    { fetch: refusing, service },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Local connection installed");
  expect(calls.map(([verb]) => verb)).toEqual(["print", "bootstrap", "kickstart"]);
  expect(
    existsSync(
      join(home, "Library", "LaunchAgents", `${MANAGED_CONNECTION_LABEL}.plist`),
    ),
  ).toBe(true);
  // The integration registry is untouched: this path is the connection alone.
  expect(existsSync(join(home, ".trace", "integrations.json"))).toBe(false);
});

test("trace connection install fails loudly when launchd refuses the job", async () => {
  const { service } = fakeLaunchd((args) =>
    args[0] === "bootstrap"
      ? { status: 5, stderr: "Input/output error\n" }
      : { status: args[0] === "print" ? 113 : 0, stderr: "" },
  );

  const result = await connectionOperation(
    ["install"],
    { env: { ...env, TRACE_CLI_PATH: "/opt/global/bin/trace" } },
    { fetch: refusing, service },
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("launchctl bootstrap gui/501");
});

test("trace connection install says what to do on a platform without launchd", async () => {
  const { calls, service } = fakeLaunchd();

  const result = await connectionOperation(
    ["install"],
    { env: { ...env, TRACE_CLI_PATH: "/opt/global/bin/trace" } },
    { fetch: refusing, service: { ...service, platform: "win32" } },
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("trace serve");
  expect(calls).toEqual([]);
});

test("trace connection usage names install", async () => {
  const result = await connectionOperation([], { env }, { fetch: refusing });

  expect(result.stderr).toContain("install");
});
