import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openTraceStore } from "@trace/core";
import {
  createServeRequestListener,
  DEFAULT_SERVE_PORT,
  openBrowser,
  resolveWebAssetsDir,
  startTraceServe,
} from "./serve.ts";

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
): CapturedResponse {
  const captured: CapturedResponse = { statusCode: 200, headers: {}, body: "" };
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
    end(chunk?: string) {
      captured.body = chunk ?? "";
    },
  } as unknown as ServerResponse;

  createServeRequestListener(databasePath, assetsDir)(
    { method, url } as IncomingMessage,
    res,
  );
  return captured;
}

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

test("trace serve serves a known asset from the web assets directory", () => {
  const response = dispatch("GET", "/assets/app.js", makeAssetsDir());

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("text/javascript");
  expect(response.body).toBe("console.log('trace');");
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

  const running = await startTraceServe({}, { server });

  expect(running.port).toBe(DEFAULT_SERVE_PORT + 1);
  expect(running.url).toBe(`http://127.0.0.1:${DEFAULT_SERVE_PORT + 1}/`);
  await running.close();
});

test("resolveWebAssetsDir finds the built web app relative to the cli module", () => {
  const moduleDir = join(dir, "apps", "cli", "src");
  const webDist = join(dir, "apps", "web", "dist");
  mkdirSync(moduleDir, { recursive: true });
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<!doctype html>");

  expect(resolveWebAssetsDir(moduleDir)).toBe(webDist);
});

test("resolveWebAssetsDir returns undefined when no built web app exists", () => {
  const moduleDir = join(dir, "apps", "cli", "src");
  mkdirSync(moduleDir, { recursive: true });

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
