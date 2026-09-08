import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPairingLinks } from "../bridge-pairing.ts";
import { openConnectionCredentials } from "../connection-credentials.ts";
import { createServeRequestListener } from "../serve.ts";
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
