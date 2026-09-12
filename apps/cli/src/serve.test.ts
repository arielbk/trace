import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPairingLinks, type PairingLinks } from "./bridge-pairing.ts";
import {
  openConnectionCredentials,
  type ConnectionCredentials,
} from "./connection-credentials.ts";
import {
  openTraceStore,
  resolveTaskDocsDir,
  unzipExportBundle,
  updateConfigFile,
  writeSyncStatusFile,
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

// `eqnx serve` listens on a real socket, which the unit environment forbids
// (EPERM on bind). We drive the request listener directly with a fake req/res
// so the routing + 404 fallback behaviour is exercised without binding.
function makeAssetsDir(): string {
  const assetsDir = join(dir, "web");
  mkdirSync(join(assetsDir, "assets"), { recursive: true });
  writeFileSync(
    join(assetsDir, "index.html"),
    "<!doctype html><title>EQNX</title>",
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
  connection?: ConnectionCredentials,
  pairing?: PairingLinks,
  requestBody?: string,
  runtimeVersion?: string,
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
    connection,
    pairing,
    runtimeVersion,
  )(request, res);
  if (requestBody !== undefined) request.emit("data", Buffer.from(requestBody));
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    request.emit("end");
  }
  return captured;
}

/** A real credential store in this test's temp HOME, with one paired browser. */
function pairedConnection(): {
  connection: ConnectionCredentials;
  token: string;
} {
  const connection = openConnectionCredentials({ HOME: dir });
  return { connection, token: connection.issueBrowserToken("Test").token };
}

test("eqnx serve exposes a read-only connection handshake", () => {
  const response = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "9.8.7",
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    service: "trace",
    protocolVersion: 1,
    runtimeVersion: "9.8.7",
    capabilities: [
      "taskDetails",
      "taskMutations",
      "docEdits",
      "taskExports",
      "account",
      "accountSignOut",
      "sync",
      "keyTransfer",
    ],
  });
});

test("eqnx serve advertises only the hosted allowlist to the hosted board", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();

  const response = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${token}` },
    allowedOrigin,
    connection,
    undefined,
    undefined,
    "9.8.7",
  );

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    service: "trace",
    protocolVersion: 1,
    runtimeVersion: "9.8.7",
    capabilities: [
      "taskDetails",
      "taskMutations",
      "account",
      "accountSignOut",
      "sync",
      "keyTransfer",
    ],
  });
});

test("eqnx serve grants API reads only to the configured hosted origin", () => {
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

test("eqnx serve requires a paired browser credential for hosted API reads", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const missing = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: allowedOrigin },
    allowedOrigin,
    connection,
  );
  const wrong = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: "Bearer wrong-secret" },
    allowedOrigin,
    connection,
  );
  const authenticated = dispatch(
    "GET",
    "/api/connection",
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${token}` },
    allowedOrigin,
    connection,
  );

  expect(missing.statusCode).toBe(401);
  expect(missing.body).toBe("Authorization required");
  expect(wrong.statusCode).toBe(401);
  expect(authenticated.statusCode).toBe(200);
  expect(JSON.parse(authenticated.body)).toMatchObject({ service: "trace" });
});

test("a revoked browser loses hosted access on its very next request", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const read = () =>
    dispatch(
      "GET",
      "/api/connection",
      undefined,
      undefined,
      { origin: allowedOrigin, authorization: `Bearer ${token}` },
      allowedOrigin,
      connection,
    ).statusCode;

  expect(read()).toBe(200);
  const paired = connection.listBrowsers();
  connection.revokeBrowser(paired[paired.length - 1]!.id);

  expect(read()).toBe(401);
});

test("eqnx serve exchanges a pairing link for that browser's own credential", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const connection = openConnectionCredentials({ HOME: dir });
  const pairing = createPairingLinks(connection.issueBrowserToken);
  const link = pairing.create();
  const headers = { origin: allowedOrigin, "content-type": "application/json" };
  const body = JSON.stringify({ secret: link.secret });

  const paired = dispatch(
    "POST",
    "/api/pairing",
    undefined,
    undefined,
    headers,
    allowedOrigin,
    connection,
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
    connection,
    pairing,
    body,
  );

  expect(paired.statusCode).toBe(200);
  expect(paired.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(paired.headers["cache-control"]).toBe("no-store");
  expect(replay.statusCode).toBe(401);

  // The minted token is this browser's own, and it authorizes hosted reads.
  const { token } = JSON.parse(paired.body) as { token: string };
  expect(connection.verifyBrowserToken(token)).not.toBeNull();
  expect(
    dispatch(
      "GET",
      "/api/connection",
      undefined,
      undefined,
      { origin: allowedOrigin, authorization: `Bearer ${token}` },
      allowedOrigin,
      connection,
    ).statusCode,
  ).toBe(200);
});

test("eqnx serve grants pairing preflight only to the configured origin", () => {
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

test("eqnx serve does not expose pairing to any other browser origin", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const connection = openConnectionCredentials({ HOME: dir });
  const pairing = createPairingLinks(connection.issueBrowserToken);
  const link = pairing.create();
  const response = dispatch(
    "POST",
    "/api/pairing",
    undefined,
    undefined,
    { origin: "https://attacker.example", "content-type": "application/json" },
    allowedOrigin,
    connection,
    pairing,
    JSON.stringify({ secret: link.secret }),
  );

  expect(response.statusCode).toBe(403);
  expect(pairing.exchange(link.secret)).not.toBeNull();
});

test("eqnx serve rejects requests with a non-loopback Host header", () => {
  const response = dispatch("GET", "/api/connection", undefined, undefined, {
    host: "attacker.example",
  });

  expect(response.statusCode).toBe(421);
  expect(response.body).toBe("Loopback Host required");
});

test("eqnx serve answers a hosted-origin API preflight", () => {
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

test("eqnx serve rejects hosted preflights that request other headers", () => {
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

test("eqnx serve rejects hosted-origin mutations outside the action allowlist", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const outside = [
    "/api/tasks/checkout/docs/checkbox",
    "/api/sync",
    "/api/auth/logout",
  ];

  for (const path of outside) {
    const response = dispatch(
      "POST",
      path,
      undefined,
      undefined,
      { origin: allowedOrigin, authorization: `Bearer ${token}` },
      allowedOrigin,
      connection,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe("Cross-origin API access denied");
  }
});

test("eqnx serve accepts authorized hosted task actions", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const response = dispatch(
    "POST",
    `/api/tasks/${taskId}/archive`,
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${token}` },
    allowedOrigin,
    connection,
  );

  expect(response.statusCode).toBe(200);
  expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(JSON.parse(response.body).archivedAt).not.toBeNull();
});

test("eqnx serve applies every enabled hosted task action to the store", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const act = (action: string) =>
    dispatch(
      "POST",
      `/api/tasks/${taskId}/${action}`,
      undefined,
      undefined,
      { origin: allowedOrigin, authorization: `Bearer ${token}` },
      allowedOrigin,
      connection,
    );

  expect(JSON.parse(act("archive").body).archivedAt).not.toBeNull();
  expect(JSON.parse(act("unarchive").body).archivedAt).toBeNull();
  expect(JSON.parse(act("pin").body).pinnedAt).not.toBeNull();
  expect(JSON.parse(act("unpin").body).pinnedAt).toBeNull();
});

test("eqnx serve guards hosted task actions by origin, credential, and method", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const hostile = dispatch(
    "POST",
    `/api/tasks/${taskId}/archive`,
    undefined,
    undefined,
    {
      origin: "https://trace-hosted.example.attacker.example",
      authorization: `Bearer ${token}`,
    },
    allowedOrigin,
    connection,
  );
  const unauthenticated = dispatch(
    "POST",
    `/api/tasks/${taskId}/archive`,
    undefined,
    undefined,
    { origin: allowedOrigin },
    allowedOrigin,
    connection,
  );
  const wrongMethod = dispatch(
    "GET",
    `/api/tasks/${taskId}/archive`,
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${token}` },
    allowedOrigin,
    connection,
  );
  const readPathPreflight = dispatch(
    "OPTIONS",
    `/api/tasks/${taskId}/timeline`,
    undefined,
    undefined,
    {
      origin: allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    },
    allowedOrigin,
    connection,
  );

  expect(hostile.statusCode).toBe(403);
  expect(hostile.headers["access-control-allow-origin"]).toBeUndefined();
  expect(unauthenticated.statusCode).toBe(401);
  expect(wrongMethod.statusCode).toBe(403);
  expect(readPathPreflight.statusCode).toBe(403);

  const store = openTraceStore(databasePath);
  try {
    expect(store.listTaskSummaries()[0]?.archivedAt ?? null).toBeNull();
  } finally {
    store.close();
  }
});

test("eqnx serve answers a hosted task-action preflight with POST only", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection } = pairedConnection();
  const response = dispatch(
    "OPTIONS",
    `/api/tasks/${taskId}/pin`,
    undefined,
    undefined,
    {
      origin: allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    },
    allowedOrigin,
    connection,
  );

  expect(response.statusCode).toBe(204);
  expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(response.headers["access-control-allow-methods"]).toBe(
    "POST, OPTIONS",
  );
  expect(response.headers["access-control-allow-headers"]).toBe(
    "authorization",
  );
});

test("eqnx serve serves task timeline reads to the authenticated hosted origin", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const response = dispatch(
    "GET",
    `/api/tasks/${taskId}/timeline`,
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${token}` },
    allowedOrigin,
    connection,
  );

  expect(response.statusCode).toBe(200);
  expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(JSON.parse(response.body).task.slug).toBe("checkout");
});

test("eqnx serve serves task doc reads to the authenticated hosted origin", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const docsDir = resolveTaskDocsDir(databasePath, "checkout");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "notes.md"), "# Notes\n\nSome content.");

  const response = dispatch(
    "GET",
    `/api/tasks/checkout/docs?path=${encodeURIComponent("notes.md")}`,
    undefined,
    undefined,
    { origin: allowedOrigin, authorization: `Bearer ${token}` },
    allowedOrigin,
    connection,
  );

  expect(response.statusCode).toBe(200);
  expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(response.body).toContain("<h1>Notes</h1>");
});

test("eqnx serve guards task detail reads by origin and credential", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const hostile = dispatch(
    "GET",
    `/api/tasks/${taskId}/timeline`,
    undefined,
    undefined,
    {
      origin: "https://trace-hosted.example.attacker.example",
      authorization: `Bearer ${token}`,
    },
    allowedOrigin,
    connection,
  );
  const unauthenticated = dispatch(
    "GET",
    `/api/tasks/${taskId}/timeline`,
    undefined,
    undefined,
    { origin: allowedOrigin },
    allowedOrigin,
    connection,
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
    connection,
  );

  expect(hostile.statusCode).toBe(403);
  expect(hostile.headers["access-control-allow-origin"]).toBeUndefined();
  expect(unauthenticated.statusCode).toBe(401);
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  expect(preflight.headers["access-control-allow-methods"]).toBe("GET, OPTIONS");
});

test("eqnx serve rejects reads outside the hosted spike allowlist", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const outside = [
    `/api/tasks/${taskId}/export`,
    `/api/tasks/${taskId}/docs/checkbox`,
    "/api/sync/docs",
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

test("what the hosted handshake advertises is exactly what the bridge allows", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const hosted = (method: string, path: string) =>
    dispatch(
      method,
      path,
      undefined,
      undefined,
      { origin: allowedOrigin, authorization: `Bearer ${token}` },
      allowedOrigin,
      connection,
    );

  // One representative request per capability the handshake can name.
  const probes: Record<string, () => CapturedResponse> = {
    taskDetails: () => hosted("GET", `/api/tasks/${taskId}/timeline`),
    taskMutations: () => hosted("POST", `/api/tasks/${taskId}/pin`),
    docEdits: () => hosted("POST", `/api/tasks/${taskId}/docs/checkbox`),
    taskExports: () => hosted("GET", `/api/tasks/${taskId}/export`),
    account: () => hosted("POST", "/api/local-auth/login"),
    accountSignOut: () => hosted("POST", "/api/local-auth/logout"),
    // The granted slice of `sync` is the status read; commanding a sync run
    // stays local-only, which the restore-routes test pins separately.
    sync: () => hosted("GET", "/api/sync/status"),
    keyTransfer: () => hosted("GET", "/api/local-auth/transfers"),
  };

  const advertised = new Set(
    (
      JSON.parse(hosted("GET", "/api/connection").body) as {
        capabilities: string[];
      }
    ).capabilities,
  );

  for (const [capability, probe] of Object.entries(probes)) {
    // A capability the runtime advertises but refuses is a broken affordance;
    // one it grants without advertising is authority nobody reviewed.
    expect([capability, probe().statusCode === 403]).toEqual([
      capability,
      !advertised.has(capability),
    ]);
  }

  // The same-origin board still does every one of them; the narrowing is the
  // hosted client's authority, not a missing feature.
  expect(dispatch("GET", `/api/tasks/${taskId}/export`).statusCode).toBe(200);
});

test("eqnx serve keeps same-origin board mutations working", () => {
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

test("eqnx serve responds to GET /api/tasks with live summaries", () => {
  const response = dispatch("GET", "/api/tasks");

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("application/json");
  const summaries = JSON.parse(response.body) as Array<{ title: string }>;
  expect(summaries.map((s) => s.title)).toEqual(["checkout"]);
});

test("eqnx serve responds to GET /api/tasks/:id/timeline with the live timeline", () => {
  const response = dispatch("GET", `/api/tasks/${taskId}/timeline`);

  expect(response.statusCode).toBe(200);
  const timeline = JSON.parse(response.body) as { task: { id: string } };
  expect(timeline.task.id).toBe(taskId);
});

test("eqnx serve returns zip bytes from GET /api/tasks/:ref/export", () => {
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

test("eqnx serve serves a known asset from the web assets directory", () => {
  const response = dispatch("GET", "/assets/app.js", makeAssetsDir());

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("text/javascript");
  expect(response.body).toBe("console.log('trace');");
});

test("eqnx serve serves binary assets byte-for-byte", () => {
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

test("eqnx serve falls back to index.html for unknown non-API paths", () => {
  const response = dispatch("GET", "/tasks/some-task-slug", makeAssetsDir());

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("text/html");
  expect(response.body).toContain("<title>EQNX</title>");
});

test("eqnx serve never serves files outside the assets directory", () => {
  const assetsDir = makeAssetsDir();
  writeFileSync(join(dir, "secret.txt"), "do not serve");

  const response = dispatch("GET", "/%2e%2e/secret.txt", assetsDir);

  expect(response.body).not.toContain("do not serve");
});

test("eqnx serve returns 404 for non-API paths when no assets directory is configured", () => {
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

test("eqnx serve falls back to the next port when the default is taken", async () => {
  const server = fakeServerWithTakenPorts(new Set([DEFAULT_SERVE_PORT]));

  const running = await startTraceServe({}, { server, triggerSync: () => {} });

  expect(running.port).toBe(DEFAULT_SERVE_PORT + 1);
  expect(running.url).toBe(`http://127.0.0.1:${DEFAULT_SERVE_PORT + 1}/`);
  await running.close();
});

test("the managed connection reports a taken port rather than moving to another", async () => {
  const server = fakeServerWithTakenPorts(new Set([DEFAULT_SERVE_PORT]));

  await expect(
    startTraceServe(
      {},
      { server, triggerSync: () => {}, allowPortFallback: false },
    ),
  ).rejects.toThrow("EADDRINUSE");
});

test("a serve that does not own periodic sync schedules none", async () => {
  vi.useFakeTimers();
  try {
    const server = fakeServerWithTakenPorts(new Set());
    const triggerSync = vi.fn();

    const running = await startTraceServe(
      {},
      { server, triggerSync, periodicSync: false },
    );
    expect(triggerSync).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PERIODIC_SYNC_INTERVAL_MS * 3);
    expect(triggerSync).toHaveBeenCalledTimes(1);

    await running.close();
  } finally {
    vi.useRealTimers();
  }
});

test("eqnx serve returns a hosted pairing URL with no query secret", async () => {
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

test("eqnx serve refuses to bind beyond the loopback interface", async () => {
  const server = fakeServerWithTakenPorts(new Set());

  await expect(
    startTraceServe({}, { host: "0.0.0.0", server, triggerSync: () => {} }),
  ).rejects.toThrow("loopback");
});

test("eqnx serve fires a background sync on start", async () => {
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

test("eqnx serve syncs periodically while running, and stops on close", async () => {
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

test("the serve process reports the EQNX version it is actually running", () => {
  const env = {
    HOME: dir,
    TRACE_DB: databasePath,
    TRACE_CURRENT_VERSION: "4.5.6",
  };
  const server = createTraceServeServer(env, undefined);
  const captured: { body: string } = { body: "" };

  server.emit(
    "request",
    {
      method: "GET",
      url: "/api/connection",
      headers: { host: "127.0.0.1:4317" },
    } as IncomingMessage,
    {
      statusCode: 200,
      setHeader: () => {},
      end: (chunk?: string) => (captured.body = chunk ?? ""),
    } as unknown as ServerResponse,
  );

  expect(JSON.parse(captured.body)).toMatchObject({
    service: "trace",
    runtimeVersion: "4.5.6",
  });
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

test("management routes require the local admin credential, not a browser one", () => {
  const { connection, token } = pairedConnection();
  const list = (headers: Record<string, string>) =>
    dispatch(
      "GET",
      "/api/management/browsers",
      undefined,
      undefined,
      headers,
      "https://trace-hosted.example",
      connection,
    );

  expect(list({}).statusCode).toBe(401);
  expect(list({ authorization: `Bearer ${token}` }).statusCode).toBe(401);

  const listed = list({
    authorization: `Bearer ${connection.managementToken}`,
  });
  expect(listed.statusCode).toBe(200);
  expect(JSON.parse(listed.body)).toEqual({
    browsers: connection.listBrowsers(),
  });
  expect(listed.body).not.toContain("digest");
});

test("management routes refuse every browser-originated request", () => {
  const { connection } = pairedConnection();
  const asBrowser = (origin: string) =>
    dispatch(
      "GET",
      "/api/management/browsers",
      undefined,
      undefined,
      {
        origin,
        authorization: `Bearer ${connection.managementToken}`,
      },
      "https://trace-hosted.example",
      connection,
    );

  // Even the hosted origin holding the management credential is a browser, and
  // no browser administers this installation.
  expect(asBrowser("https://trace-hosted.example").statusCode).toBe(403);
  expect(asBrowser("http://127.0.0.1:4317").statusCode).toBe(403);
});

test("the running service issues a pairing link without restarting", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const connection = openConnectionCredentials({ HOME: dir });
  const pairing = createPairingLinks(connection.issueBrowserToken);

  const issued = dispatch(
    "POST",
    "/api/management/pairings",
    undefined,
    undefined,
    { authorization: `Bearer ${connection.managementToken}` },
    allowedOrigin,
    connection,
    pairing,
    "",
  );

  expect(issued.statusCode).toBe(200);
  expect(issued.headers["cache-control"]).toBe("no-store");
  const link = JSON.parse(issued.body) as { url: string; expiresAt: number };
  expect(link.url).toMatch(
    /^https:\/\/trace-hosted\.example\/#trace-pair=[A-Za-z0-9_-]{43}$/,
  );
  expect(link.expiresAt).toBeGreaterThan(Date.now());

  const secret = new URL(link.url).hash.replace("#trace-pair=", "");
  expect(pairing.exchange(secret)).not.toBeNull();
});

test("management revocation and reset take effect immediately", () => {
  const { connection, token } = pairedConnection();
  const second = connection.issueBrowserToken("Second");
  const manage = (method: string, path: string) =>
    dispatch(
      method,
      path,
      undefined,
      undefined,
      { authorization: `Bearer ${connection.managementToken}` },
      "https://trace-hosted.example",
      connection,
      undefined,
      "",
    );

  const revoked = manage("POST", `/api/management/browsers/${second.id}/revoke`);
  expect(revoked.statusCode).toBe(200);
  expect(connection.verifyBrowserToken(second.token)).toBeNull();
  expect(connection.verifyBrowserToken(token)).not.toBeNull();
  expect(
    manage("POST", "/api/management/browsers/never-paired/revoke").statusCode,
  ).toBe(404);

  const reset = manage("POST", "/api/management/reset");
  expect(reset.statusCode).toBe(200);
  expect(connection.listBrowsers()).toEqual([]);
  expect(connection.verifyBrowserToken(token)).toBeNull();
  // Reset revokes browsers; local management authority survives it.
  expect(manage("GET", "/api/management/browsers").statusCode).toBe(200);
});

test("the hosted board may drive the restore routes it needs and nothing more", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const { connection, token } = pairedConnection();
  const hosted = (method: string, path: string, body?: string) =>
    dispatch(
      method,
      path,
      undefined,
      undefined,
      { origin: allowedOrigin, authorization: `Bearer ${token}` },
      allowedOrigin,
      connection,
      undefined,
      body,
    );

  const granted = [
    ["POST", "/api/local-auth/logout"],
    ["GET", "/api/sync/status"],
    ["GET", "/api/local-auth/login/current"],
    ["GET", "/api/local-auth/login/an-attempt"],
    ["POST", "/api/local-auth/login"],
    ["POST", "/api/local-auth/login/an-attempt/existing-key"],
    ["POST", "/api/local-auth/login/an-attempt/cancel"],
    // Being let in by another machine, and letting one in.
    ["POST", "/api/local-auth/login/an-attempt/transfer"],
    ["POST", "/api/local-auth/login/an-attempt/transfer/cancel"],
    ["GET", "/api/local-auth/transfers"],
    ["POST", "/api/local-auth/transfers/a-request/open"],
    ["POST", "/api/local-auth/transfers/a-request/approve"],
    ["POST", "/api/local-auth/transfers/a-request/deny"],
  ] as const;
  for (const [method, path] of granted) {
    expect([path, hosted(method, path).statusCode]).not.toEqual([path, 403]);
  }

  // Replacing a key destroys readable documents, acknowledging one would carry
  // a plaintext key to a remote origin; explicit sync pushes stay local-only.
  const refused = [
    ["POST", "/api/local-auth/login/an-attempt/replacement-key"],
    ["POST", "/api/local-auth/login/an-attempt/acknowledge-key"],
    ["POST", "/api/sync"],
  ] as const;
  for (const [method, path] of refused) {
    expect([path, hosted(method, path).statusCode]).toEqual([path, 403]);
  }
});

test("a hosted restore POST may preflight a JSON body, and nothing else may", () => {
  const allowedOrigin = "https://trace-hosted.example";
  const preflight = (path: string, method: string, headers: string) =>
    dispatch(
      "OPTIONS",
      path,
      undefined,
      undefined,
      {
        origin: allowedOrigin,
        "access-control-request-method": method,
        "access-control-request-headers": headers,
      },
      allowedOrigin,
    );

  const key = preflight(
    "/api/local-auth/login/an-attempt/existing-key",
    "POST",
    "authorization, content-type",
  );
  expect(key.statusCode).toBe(204);
  expect(key.headers["access-control-allow-headers"]).toBe(
    "authorization, content-type",
  );
  expect(key.headers["access-control-allow-methods"]).toBe("POST, OPTIONS");

  // A bodyless action need not announce a content type, and is not forced to.
  expect(
    preflight("/api/local-auth/login/an-attempt/cancel", "POST", "authorization")
      .statusCode,
  ).toBe(204);

  // Widening the account routes must not widen the task surface: a JSON body on
  // a task action is still not something this bridge accepts.
  expect(
    preflight(`/api/tasks/${taskId}/pin`, "POST", "authorization, content-type")
      .statusCode,
  ).toBe(403);
});

test("hosted sign-out preflights POST but still requires a paired browser", () => {
  const origin = "https://board.test";
  const { connection } = pairedConnection();
  const preflight = dispatch(
    "OPTIONS",
    "/api/local-auth/logout",
    undefined,
    undefined,
    {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    },
    origin,
    connection,
  );
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
  expect(
    dispatch(
      "POST",
      "/api/local-auth/logout",
      undefined,
      undefined,
      { origin },
      origin,
      connection,
    ).statusCode,
  ).toBe(401);
  expect(
    dispatch(
      "POST",
      "/api/local-auth/logout",
      undefined,
      undefined,
      { origin: "https://untrusted.test" },
      origin,
      connection,
    ).statusCode,
  ).toBe(403);
});


test("a stale signed-in status cannot sign in a machine without credentials", () => {
  writeSyncStatusFile(databasePath, { loggedIn: true, identity: "Previous account" });
  const server = createTraceServeServer({ HOME: dir, TRACE_DB: databasePath, TRACE_SERVER_URL: "https://sync.test" });
  let body = "";
  server.emit("request", {
    method: "GET", url: "/api/sync/status", headers: { host: "127.0.0.1:4317" },
  } as IncomingMessage, {
    setHeader: () => {}, end: (chunk: string) => { body = chunk; },
  } as unknown as ServerResponse);
  expect(JSON.parse(body)).toEqual({ state: "logged-out", serverConfigured: true, autoSync: true });
});
