import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPairingLinks } from "../bridge-pairing.ts";
import { openConnectionCredentials } from "../connection-credentials.ts";
import { CONNECTION_ENDPOINT_ORIGIN } from "../connection-endpoint.ts";
import { createServeRequestListener } from "../serve.ts";
import { boardOperation } from "./board-operations.ts";

const HOSTED_ORIGIN = "https://board.trace.example";

let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trace-board-command-"));
  env = { HOME: home, TRACE_DB: join(home, "trace.sqlite") };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A `fetch` that drives the real serve listener, so the opener is exercised
 * against the handler the managed connection actually runs. */
function runningService(): typeof globalThis.fetch {
  const connection = openConnectionCredentials(env);
  const listener = createServeRequestListener(
    join(home, "trace.sqlite"),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    HOSTED_ORIGIN,
    connection,
    createPairingLinks((label) => connection.issueBrowserToken(label)),
    "9.9.9",
  );

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

/** Nothing is listening on the endpoint. */
const noService = (() =>
  Promise.reject(new Error("connect ECONNREFUSED"))) as typeof globalThis.fetch;

test("trace board opens the hosted board through a fresh pairing link", async () => {
  const opened: string[] = [];
  const start = vi.fn();

  const result = await boardOperation(
    [],
    { env: { ...env, TRACE_WEB_ORIGIN: HOSTED_ORIGIN } },
    { fetch: runningService(), open: (url) => opened.push(url), start },
  );

  expect(result.exitCode).toBe(0);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(
    new RegExp(`^${HOSTED_ORIGIN}/#trace-pair=[A-Za-z0-9_-]{43}$`),
  );
  expect(result.stdout).toContain(opened[0] as string);
  // The running connection is reused as it stands: opening the board never
  // starts a second runtime.
  expect(start).not.toHaveBeenCalled();
});

test("trace board falls back to the bundled board when no hosted origin is configured", async () => {
  const opened: string[] = [];
  const start = vi.fn().mockResolvedValue({
    url: "http://127.0.0.1:4317/",
    port: 4317,
    close: () => Promise.resolve(),
  });

  const result = await boardOperation(
    [],
    { env },
    { fetch: noService, open: (url) => opened.push(url), start },
  );

  expect(result.exitCode).toBe(0);
  expect(opened).toEqual(["http://127.0.0.1:4317/"]);
  expect(start).toHaveBeenCalledOnce();
});

test("trace board says the connection is stopped rather than opening a board that cannot read it", async () => {
  const opened: string[] = [];
  const start = vi.fn();

  const result = await boardOperation(
    [],
    { env: { ...env, TRACE_WEB_ORIGIN: HOSTED_ORIGIN } },
    { fetch: noService, open: (url) => opened.push(url), start },
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("trace connection install");
  expect(result.stderr).toContain("trace board --local");
  expect(opened).toEqual([]);
  expect(start).not.toHaveBeenCalled();
});

test("trace board --local reuses the running connection instead of a second runtime", async () => {
  const opened: string[] = [];
  const start = vi.fn();

  const result = await boardOperation(
    ["--local"],
    { env: { ...env, TRACE_WEB_ORIGIN: HOSTED_ORIGIN } },
    { fetch: runningService(), open: (url) => opened.push(url), start },
  );

  expect(result.exitCode).toBe(0);
  expect(opened).toEqual([`${CONNECTION_ENDPOINT_ORIGIN}/`]);
  expect(start).not.toHaveBeenCalled();
});

test("trace board --local opens the port the bundled board fell back to", async () => {
  const opened: string[] = [];
  const start = vi.fn().mockResolvedValue({
    url: "http://127.0.0.1:4318/",
    port: 4318,
    close: () => Promise.resolve(),
  });
  // Something that is not Trace holds the endpoint.
  const occupiedPort = (async () =>
    new Response("nginx", { status: 200 })) as typeof globalThis.fetch;

  const result = await boardOperation(
    ["--local"],
    { env },
    { fetch: occupiedPort, open: (url) => opened.push(url), start },
  );

  expect(result.exitCode).toBe(0);
  expect(opened).toEqual(["http://127.0.0.1:4318/"]);
  expect(result.stdout).toContain("http://127.0.0.1:4318/");
});

test("trace board rejects an option it does not know", async () => {
  const result = await boardOperation(
    ["--hosted"],
    { env },
    { fetch: noService, open: () => {} },
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Usage: trace board [--local]");
});
