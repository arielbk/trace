import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createBridgePairing,
  createBridgePairingUrl,
  type BridgePairing,
} from "./bridge-pairing.ts";
import {
  openTraceStore,
  resolveTaskDocsDir,
  unzipExportBundle,
  updateConfigFile,
} from "@trace/core";
import {
  createServeRequestListener,
  createSyncHooks,
  createTraceServeServer,
  DEFAULT_SERVE_PORT,
  MUTATION_SYNC_DELAY_MS,
  PERIODIC_SYNC_INTERVAL_MS,
  REQUEST_SYNC_MIN_INTERVAL_MS,
  resolveWebAssetsDir,
  startTraceServe,
  type ServeSyncHooks,
} from "./serve.ts";
import { openBrowser } from "./open-browser.ts";

let dir: string;
let databasePath: string;
let taskId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-serve-"));
  databasePath = join(dir, "trace.sqlite");
  const store = openTraceStore(databasePath);
  try {
    taskId = store.createTask("checkout").id;
  } finally {
    store.close();
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  rawBody: Buffer | string | undefined;
};

// `trace serve` listens on a real socket, which the unit environment forbids
// (EPERM on bind). We drive the request listener directly with a fake req/res
// so the routing + 404 fallback behaviour is exercised without binding.
function makeAssetsDir(): string {
  const assetsDir = join(dir, "web");
  mkdirSync(join(assetsDir, "assets"), { recursive: true });
  writeFileSync(
    join(assetsDir, "index.html"),
    "<!doctype html><title>Trace</title>",
  );
  writeFileSync(join(assetsDir, "assets", "app.js"), "console.log('trace');");
  return assetsDir;
}

function dispatch(
  method: string,
  url: string,
  assetsDir?: string,
  syncHooks?: ServeSyncHooks,
  requestHeaders: Record<string, string> = {},
  allowedWebOrigin?: string,
  bridgeCredential?: string,
  bridgePairing?: BridgePairing,
  requestBody?: string,
): CapturedResponse {
  const captured: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: "",
    rawBody: undefined,
  };
  const res = {
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    get statusCode() {
      return captured.statusCode;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: Buffer | string) {
      captured.rawBody = chunk;
      captured.body = chunk === undefined ? "" : chunk.toString("utf8");
    },
  } as unknown as ServerResponse;

  const request = new EventEmitter() as unknown as IncomingMessage &
    EventEmitter;
  Object.assign(request, {
    method,
    url,
    headers: { host: "127.0.0.1:4317", ...requestHeaders },
  });

  createServeRequestListener(
    databasePath,
    assetsDir,
    undefined,
    syncHooks,
    undefined,
    undefined,
    allowedWebOrigin,
    bridgeCredential,
    bridgePairing,
  )(request, res);
  if (requestBody !== undefined) request.emit("data", Buffer.from(requestBody));
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    request.emit("end");
  }
  return captured;
}

test("trace serve exposes a read-only connection handshake", () => {
  const response = dispatch("GET", "/api/connection");

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    service: "trace",
    protocolVersion: 1,
  });
});

test("trace serve grants API reads only to the configured hosted origin", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const allowed = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: allowedOrigin },
    allowedOrigin,
  );
  const other = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: "https://trace-hosted.example.attacker.example" },
    allowedOrigin,
  );

  expect(allowed.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(allowed.headers.vary).toBe("Origin");
  expect(other.statusCode).toBe(403);
  expect(other.headers["access-control-allow-origin"]).toBeUndefined();
});

test("trace serve requires the installation credential for hosted API reads", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const credential = "installation-secret";
  const missing = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: allowedOrigin },
    allowedOrigin,
    credential,
  );
  const wrong = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: "Bearer wrong-secret" },
    allowedOrigin,
    credential,
  );
  const authenticated = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${credential}` },
    allowedOrigin,
    credential,
  );

  expect(missing.statusCode).toBe(401);
  expect(missing.body).toBe("Authorization required");
  expect(wrong.statusCode).toBe(401);
  expect(authenticated.statusCode).toBe(200);
  expect(JSON.parse(authenticated.body)).toMatchObject({ service: "trace" });
});

test("a browser pairing secret exchanges the installation credential only once", () => {
  const credential = "installation-secret";
  const pairing = createBridgePairing(credential);

  expect(pairing.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pairing.exchange("wrong-secret")).toBeNull();
  expect(pairing.exchange(pairing.secret)).toBe(credential);
  expect(pairing.exchange(pairing.secret)).toBeNull();
});

test("the pairing URL keeps its one-time secret in the fragment", () => {
  const url = createBridgePairingUrl(
    "https://trace-hosted.example",
    "one-time-secret",
  );

  expect(url).toBe("https://trace-hosted.example/#trace-pair=one-time-secret");
  expect(new URL(url).search).toBe("");
});

test("trace serve exchanges a pairing secret once without bearer authorization", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const credential = "installation-secret";
  const pairing = createBridgePairing(credential);
  const headers = { origin: allowedOrigin, "content-type": "application/json" };
  const body = JSON.stringify({ secret: pairing.secret });

  const paired = dispatch(
    "POST",
    "/api/pairing",
    undefined,
    undefined,
    headers,
    allowedOrigin,
    credential,
    pairing,
    body,
  );
  const replay = dispatch(
    "POST",
    "/api/pairing",
    undefined,
    undefined,
    headers,
    allowedOrigin,
    credential,
    pairing,
    body,
  );

  expect(paired.statusCode).toBe(200);
  expect(paired.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(paired.headers["cache-control"]).toBe("no-store");
  expect(JSON.parse(paired.body)).toEqual({ token: credential });
  expect(replay.statusCode).toBe(401);
});

test("trace serve grants pairing preflight only to the configured origin", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const response = dispatch(
    "OPTIONS",
    "/api/pairing",
    undefined,
    undefined,
    {
      origin: allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
    allowedOrigin,
  );

  expect(response.statusCode).toBe(204);
  expect(response.headers["access-control-allow-methods"]).toBe(
    "POST, OPTIONS",
  );
  expect(response.headers["access-control-allow-headers"]).toBe("content-type");
});

test("trace serve does not expose pairing to any other browser origin", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const credential = "installation-secret";
  const pairing = createBridgePairing(credential);
  const response = dispatch(
    "POST",
    "/api/pairing",
    undefined,
    undefined,
    { origin: "https://attacker.example", "content-type": "application/json" },
    allowedOrigin,
    credential,
    pairing,
    JSON.stringify({ secret: pairing.secret }),
  );

  expect(response.statusCode).toBe(403);
  expect(pairing.exchange(pairing.secret)).toBe(credential);
});

test("trace serve rejects requests with a non-loopback Host header", () => {
  const response = dispatch("GET", "/api/connection", undefined, undefined, {
    host: "attacker.example",
  });

  expect(response.statusCode).toBe(421);
  expect(response.body).toBe("Loopback Host required");
});

test("trace serve answers a hosted-origin API preflight", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const response = dispatch(
    "OPTIONS",
    "/api/tasks",
    undefined,
    undefined,
    {
      origin: allowedOrigin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "Authorization",
      "access-control-request-private-network": "true",
    },
    allowedOrigin,
  );

  expect(response.statusCode).toBe(204);
  expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(response.headers["access-control-allow-methods"]).toContain("GET");
  expect(response.headers["access-control-allow-headers"]).toBe(
    "authorization",
  );
  expect(response.headers["access-control-allow-private-network"]).toBe("true");
});

test("trace serve rejects hosted preflights that request other headers", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const response = dispatch(
    "OPTIONS",
    "/api/tasks",
    undefined,
    undefined,
    {
      origin: allowedOrigin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization, x-untrusted",
    },
    allowedOrigin,
  );

  expect(response.statusCode).toBe(403);
  expect(response.body).toBe("Cross-origin API access denied");
});

test("trace serve rejects hosted-origin mutations before dispatch", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const response = dispatch(
    "POST",
    "/api/tasks/checkout/archive",
    undefined,
    undefined,
    { origin: allowedOrigin },
    allowedOrigin,
  );

  expect(response.statusCode).toBe(403);
  expect(response.body).toBe("Cross-origin API access denied");
});

test("trace serve serves task timeline reads to the authenticated hosted origin", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const credential = "installation-secret";
  const response = dispatch(
    "GET",
    `/api/tasks/${taskId}/timeline`,
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${credential}` },
    allowedOrigin,
    credential,
  );

  expect(response.statusCode).toBe(200);
  expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(JSON.parse(response.body).task.slug).toBe("checkout");
});

test("trace serve serves task doc reads to the authenticated hosted origin", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const credential = "installation-secret";
  const docsDir = resolveTaskDocsDir(databasePath, "checkout");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "notes.md"), "# Notes\n\nSome content.");

  const response = dispatch(
    "GET",
    `/api/tasks/checkout/docs?path=${encodeURIComponent("notes.md")}`,
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${credential}` },
    allowedOrigin,
    credential,
  );

  expect(response.statusCode).toBe(200);
  expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(response.body).toContain("<h1>Notes</h1>");
});

test("trace serve guards task detail reads by origin and credential", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const credential = "installation-secret";
  const hostile = dispatch(
    "GET",
    `/api/tasks/${taskId}/timeline`,
    undefined,
    undefined,
    {
      origin: "https://trace-hosted.example.attacker.example",
      authorization: `Bearer ${credential}`,
    },
    allowedOrigin,
    credential,
  );
  const unauthenticated = dispatch(
    "GET",
    `/api/tasks/${taskId}/timeline`,
    undefined,
    undefined,
    { origin: allowedOrigin },
    allowedOrigin,
    credential,
  );
  const preflight = dispatch(
    "OPTIONS",
    `/api/tasks/${taskId}/timeline`,
    undefined,
    undefined,
    {
      origin: allowedOrigin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
    allowedOrigin,
    credential,
  );

  expect(hostile.statusCode).toBe(403);
  expect(hostile.headers["access-control-allow-origin"]).toBeUndefined();
  expect(unauthenticated.statusCode).toBe(401);
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(preflight.headers["access-control-allow-methods"]).toBe("GET, OPTIONS");
});

test("trace serve rejects reads outside the hosted spike allowlist", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const outside = [
    `/api/tasks/${taskId}/export`,
    `/api/tasks/${taskId}/docs/checkbox`,
    "/api/sync/status",
  ];

  for (const path of outside) {
    const response = dispatch(
      "GET",
      path,
      undefined,
      undefined,
      { origin: allowedOrigin },
      allowedOrigin,
    );

    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  }
});

test("trace serve keeps same-origin board mutations working", () => {
  const response = dispatch(
    "POST",
    `/api/tasks/${taskId}/archive`,
    undefined,
    undefined,
    { origin: "http://127.0.0.1:4317", host: "127.0.0.1:4317" },
    "https://trace-hosted.example",
  );

  expect(response.statusCode).toBe(200);
});

test("trace serve responds to GET /api/tasks with live summaries", () => {
  const response = dispatch("GET", "/api/tasks");

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("application/json");
  const summaries = JSON.parse(response.body) as Array<{ title: string }>;
  expect(summaries.map((s) => s.title)).toEqual(["checkout"]);
});

test("trace serve responds to GET /api/tasks/:id/timeline with the live timeline", () => {
  const response = dispatch("GET", `/api/tasks/${taskId}/timeline`);

  expect(response.statusCode).toBe(200);
  const timeline = JSON.parse(response.body) as { task: { id: string } };
  expect(timeline.task.id).toBe(taskId);
});

test("trace serve returns zip bytes from GET /api/tasks/:ref/export", () => {
  const response = dispatch("GET", `/api/tasks/${taskId}/export`);
  const date = new Date().toISOString().slice(0, 10);

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("application/zip");
  expect(response.headers["content-disposition"]).toBe(
    `attachment; filename="checkout-${date}.zip"`,
  );
  expect(response.rawBody).toBeInstanceOf(Uint8Array);
  expect(typeof response.rawBody).not.toBe("string");
  const files = unzipExportBundle(response.rawBody as Uint8Array);
  expect(
    Object.keys(files).some((path) => path.endsWith("/manifest.json")),
  ).toBe(true);
});

test("trace serve serves a known asset from the web assets directory", () => {
  const response = dispatch("GET", "/assets/app.js", makeAssetsDir());

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("text/javascript");
  expect(response.body).toBe("console.log('trace');");
});

test("trace serve serves binary assets byte-for-byte", () => {
  const assetsDir = makeAssetsDir();
  // A minimal PNG header: bytes outside valid UTF-8, which a text read mangles
  // into replacement characters.
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  writeFileSync(join(assetsDir, "assets", "icon.png"), pngBytes);

  const response = dispatch("GET", "/assets/icon.png", assetsDir);

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("image/png");
  expect(Buffer.isBuffer(response.rawBody)).toBe(true);
  expect(response.rawBody).toEqual(pngBytes);
});

test("trace serve falls back to index.html for unknown non-API paths", () => {
  const response = dispatch("GET", "/tasks/some-task-slug", makeAssetsDir());

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("text/html");
  expect(response.body).toContain("<title>Trace</title>");
});

test("trace serve never serves files outside the assets directory", () => {
  const assetsDir = makeAssetsDir();
  writeFileSync(join(dir, "secret.txt"), "do not serve");

  const response = dispatch("GET", "/%2e%2e/secret.txt", assetsDir);

  expect(response.body).not.toContain("do not serve");
});

test("trace serve returns 404 for non-API paths when no assets directory is configured", () => {
  const response = dispatch("GET", "/some/spa/route");

  expect(response.statusCode).toBe(404);
});

// Binding a real socket is forbidden in the unit environment (EPERM), so port
// fallback is exercised against a fake Server whose listen() reports the
// default port as already taken.
function fakeServerWithTakenPorts(takenPorts: Set<number>): Server {
  const emitter = new EventEmitter() as unknown as Server & EventEmitter;
  let boundPort: number | null = null;
  Object.assign(emitter, {
    listen(port: number, _host: string, onListening: () => void) {
      process.nextTick(() => {
        if (takenPorts.has(port)) {
          const error = new Error(
            `listen EADDRINUSE: address already in use :::${port}`,
          ) as NodeJS.ErrnoException;
          error.code = "EADDRINUSE";
          emitter.emit("error", error);
          return;
        }
        boundPort = port;
        onListening();
      });
      return emitter;
    },
    address: () => (boundPort === null ? null : { port: boundPort }),
    close: (onClose?: (error?: Error) => void) => onClose?.(),
  });
  return emitter;
}

test("trace serve falls back to the next port when the default is taken", async () => {
  const server = fakeServerWithTakenPorts(new Set([DEFAULT_SERVE_PORT]));

  const running = await startTraceServe({}, { server, triggerSync: () => {} });

  expect(running.port).toBe(DEFAULT_SERVE_PORT + 1);
  expect(running.url).toBe(`http://127.0.0.1:${DEFAULT_SERVE_PORT + 1}/`);
  await running.close();
});

test("trace serve returns a hosted pairing URL with no query secret", async () => {
  const server = fakeServerWithTakenPorts(new Set());
  const running = await startTraceServe(
    { HOME: dir, TRACE_WEB_ORIGIN: "https://trace-hosted.example" },
    { server, triggerSync: () => {} },
  );

  expect(running.pairingUrl).toMatch(
    /^https:\/\/trace-hosted\.example\/#trace-pair=[A-Za-z0-9_-]{43}$/,
  );
  expect(new URL(running.pairingUrl as string).search).toBe("");
  await running.close();
});

test("trace serve refuses to bind beyond the loopback interface", async () => {
  const server = fakeServerWithTakenPorts(new Set());

  await expect(
    startTraceServe({}, { host: "0.0.0.0", server, triggerSync: () => {} }),
  ).rejects.toThrow("loopback");
});

test("trace serve fires a background sync on start", async () => {
  const server = fakeServerWithTakenPorts(new Set());
  const triggerSync = vi.fn();

  const running = await startTraceServe({}, { server, triggerSync });

  expect(triggerSync).toHaveBeenCalledOnce();
  await running.close();
});

test("board mutations and POST /api/sync reach the sync hooks through the serve listener", () => {
  const syncHooks = {
    onMutation: vi.fn(),
    requestSync: vi.fn(),
    onLoginComplete: vi.fn(),
  };

  dispatch("POST", `/api/tasks/${taskId}/pin`, undefined, syncHooks);
  expect(syncHooks.onMutation).toHaveBeenCalledOnce();
  expect(syncHooks.requestSync).not.toHaveBeenCalled();

  dispatch("POST", "/api/sync", undefined, syncHooks);
  expect(syncHooks.requestSync).toHaveBeenCalledOnce();

  // Reads never schedule a sync.
  dispatch("GET", "/api/tasks", undefined, syncHooks);
  expect(syncHooks.onMutation).toHaveBeenCalledOnce();
});

test("createSyncHooks debounces a burst of mutations into one sync", () => {
  vi.useFakeTimers();
  try {
    const trigger = vi.fn();
    const hooks = createSyncHooks(trigger);

    hooks.onMutation();
    hooks.onMutation();
    vi.advanceTimersByTime(MUTATION_SYNC_DELAY_MS - 1);
    hooks.onMutation();
    expect(trigger).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MUTATION_SYNC_DELAY_MS);
    expect(trigger).toHaveBeenCalledOnce();

    // A later mutation schedules a fresh sync.
    hooks.onMutation();
    vi.advanceTimersByTime(MUTATION_SYNC_DELAY_MS);
    expect(trigger).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("createSyncHooks runs a requested sync immediately but throttles repeats", () => {
  let now = 1_000_000;
  const trigger = vi.fn();
  const hooks = createSyncHooks(trigger, () => now);

  hooks.requestSync();
  expect(trigger).toHaveBeenCalledOnce();

  now += REQUEST_SYNC_MIN_INTERVAL_MS - 1;
  hooks.requestSync();
  expect(trigger).toHaveBeenCalledOnce();

  now += 1;
  hooks.requestSync();
  expect(trigger).toHaveBeenCalledTimes(2);
});

test("createSyncHooks syncs on a completed login immediately, without throttling it", () => {
  // A clock that never moves: whatever the request throttle is holding, it is
  // still holding it when the login completes.
  const trigger = vi.fn();
  const hooks = createSyncHooks(trigger, () => 1_000_000);

  // The board's own start-up sync has just run and taken the request throttle
  // with it; a login completing seconds later is exactly the case the periodic
  // interval handles badly, so it must not be swallowed.
  hooks.requestSync();
  hooks.onLoginComplete();

  expect(trigger).toHaveBeenCalledTimes(2);
});

test("trace serve syncs periodically while running, and stops on close", async () => {
  vi.useFakeTimers();
  try {
    const server = fakeServerWithTakenPorts(new Set());
    const triggerSync = vi.fn();

    const running = await startTraceServe({}, { server, triggerSync });
    expect(triggerSync).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PERIODIC_SYNC_INTERVAL_MS);
    expect(triggerSync).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PERIODIC_SYNC_INTERVAL_MS);
    expect(triggerSync).toHaveBeenCalledTimes(3);

    await running.close();
    vi.advanceTimersByTime(PERIODIC_SYNC_INTERVAL_MS * 2);
    expect(triggerSync).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test("resolveWebAssetsDir finds the built web app relative to the cli module", () => {
  const moduleDir = join(dir, "apps", "cli", "src");
  const webDist = join(dir, "apps", "web", "dist");
  mkdirSync(moduleDir, { recursive: true });
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<!doctype html>");

  expect(resolveWebAssetsDir(moduleDir)).toBe(webDist);
});

test("resolveWebAssetsDir finds web assets beside the plugin bundle", () => {
  const moduleDir = join(dir, "extracted", "bundle");
  const bundleDir = join(dir, "plugin", "bin");
  const pluginWeb = join(bundleDir, "web");
  mkdirSync(moduleDir, { recursive: true });
  mkdirSync(pluginWeb, { recursive: true });
  writeFileSync(join(pluginWeb, "index.html"), "<!doctype html>");

  expect(resolveWebAssetsDir(moduleDir, bundleDir)).toBe(pluginWeb);
});

test("resolveWebAssetsDir finds web assets beside the built CLI bundle", () => {
  const moduleDir = join(dir, "package", "dist");
  const bundledWeb = join(moduleDir, "web");
  mkdirSync(bundledWeb, { recursive: true });
  writeFileSync(join(bundledWeb, "index.html"), "<!doctype html>");

  expect(resolveWebAssetsDir(moduleDir)).toBe(bundledWeb);
});

test("resolveWebAssetsDir returns undefined when no built web app exists", () => {
  const moduleDir = join(dir, "apps", "cli", "src");
  const hostedWebDist = join(dir, "apps", "web", "dist-hosted");
  mkdirSync(moduleDir, { recursive: true });
  mkdirSync(hostedWebDist, { recursive: true });
  writeFileSync(join(hostedWebDist, "index.html"), "<!doctype html>");

  expect(resolveWebAssetsDir(moduleDir)).toBeUndefined();
});

test("openBrowser launches the platform opener with the url", () => {
  const launched: Array<{ command: string; args: string[] }> = [];
  const spawn = (command: string, args: string[]) => {
    launched.push({ command, args });
    return { unref: () => {}, on: () => {} };
  };

  openBrowser("http://127.0.0.1:4317/", "darwin", spawn);
  openBrowser("http://127.0.0.1:4317/", "linux", spawn);

  expect(launched).toEqual([
    { command: "open", args: ["http://127.0.0.1:4317/"] },
    { command: "xdg-open", args: ["http://127.0.0.1:4317/"] },
  ]);
});

test("the board's sync status reports the machine's AutoSync mode as it changes", () => {
  const env = { HOME: dir, TRACE_DB: databasePath };
  const server = createTraceServeServer(env, undefined);
  const readAutoSync = (): unknown => {
    const captured: { body: string } = { body: "" };
    server.emit(
      "request",
      {
        method: "GET",
        url: "/api/sync/status",
        headers: { host: "127.0.0.1:4317" },
      } as IncomingMessage,
      {
        statusCode: 200,
        setHeader: () => {},
        end: (chunk?: string) => (captured.body = chunk ?? ""),
      } as unknown as ServerResponse,
    );
    return (JSON.parse(captured.body) as { autoSync: unknown }).autoSync;
  };

  expect(readAutoSync()).toBe(true);

  // Opting out while the board is open must be visible on the next poll, not
  // only after a restart.
  updateConfigFile(databasePath, { autoSync: false });
  expect(readAutoSync()).toBe(false);
});
