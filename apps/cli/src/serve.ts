import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleTraceApiRequest,
  resolveDatabasePath,
  writeTraceApiResponse,
} from "@trace/core";
import { triggerBackgroundSync } from "./commands/sync.ts";

/** Default port `trace serve` listens on. */
export const DEFAULT_SERVE_PORT = 4317;

export type TraceServer = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

export type StartTraceServeOptions = {
  port?: number;
  host?: string;
  /** Injectable server, used by tests (the unit env cannot bind sockets). */
  server?: Server;
  /** Injectable background-sync trigger; defaults to the real fire-and-forget
   * spawn. Overridden by tests. */
  triggerSync?: (env: Record<string, string | undefined>) => void;
};

/** How many consecutive ports to try when the preferred one is taken. */
const PORT_FALLBACK_ATTEMPTS = 10;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

declare global {
  // Set by the generated CLI bundle before temporary module extraction.
  // Source builds leave it undefined and fall back to apps/web/dist.
  var __TRACE_BUNDLE_DIR__: string | undefined;
}

/** Resolve a request path to a file inside `assetsDir`, or null if it escapes
 * the directory or doesn't exist as a file. */
function resolveAssetFile(assetsDir: string, urlPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const root = resolve(assetsDir);
  const candidate = normalize(join(root, decodedPath));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null;
  }

  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function serveFile(res: ServerResponse, filePath: string): void {
  res.statusCode = 200;
  res.setHeader(
    "content-type",
    CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
  );
  res.end(readFileSync(filePath));
}

/**
 * The `trace serve` request handler. API routing goes through the shared
 * `@trace/core` router, so the served endpoints match the Vite dev middleware
 * exactly. Non-API requests are served from `assetsDir` (the built web SPA);
 * without an assets directory they get a 404.
 */
export function createServeRequestListener(
  databasePath: string,
  assetsDir?: string,
  syncServerConfigured?: boolean,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    const dispatch = (body?: string): void => {
      const response = handleTraceApiRequest(databasePath, method, url, body, {
        syncServerConfigured,
      });

      if (response) {
        writeTraceApiResponse(res, response);
        return;
      }

      serveOrFallback(res, url, assetsDir);
    };

    // Only methods that carry a payload need their body buffered, and only when
    // `req` is a real stream (tests drive a bare {method,url} object).
    if (methodMayHaveBody(method) && typeof req.on === "function") {
      collectRequestBody(req, dispatch);
    } else {
      dispatch();
    }
  };
}

/** HTTP methods whose request body the API may need to read. */
function methodMayHaveBody(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

/** Buffer a request body to a UTF-8 string, then hand it to `onBody`. */
function collectRequestBody(
  req: IncomingMessage,
  onBody: (body: string) => void,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => onBody(Buffer.concat(chunks).toString("utf8")));
  req.on("error", () => onBody(""));
}

/** Serve a static asset for `url`, falling back to index.html, else 404. */
function serveOrFallback(
  res: ServerResponse,
  url: string,
  assetsDir?: string,
): void {
  const urlPath = url.split("?", 1)[0] ?? url;
  const assetFile = assetsDir
    ? (resolveAssetFile(assetsDir, urlPath) ??
      // SPA fallback: client-side routes resolve to index.html.
      resolveAssetFile(assetsDir, "/index.html"))
    : null;
  if (assetFile) {
    serveFile(res, assetFile);
    return;
  }

  res.statusCode = 404;
  res.end();
}

type BrowserSpawn = (
  command: string,
  args: string[],
) => { unref: () => void; on: (event: string, handler: () => void) => void };

const defaultBrowserSpawn: BrowserSpawn = (command, args) =>
  nodeSpawn(command, args, { detached: true, stdio: "ignore" });

/**
 * Open `url` in the user's default browser. Best-effort: failures are ignored —
 * the URL is printed to the terminal either way.
 */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: BrowserSpawn = defaultBrowserSpawn,
): void {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url] as string[]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url] as string[]]
        : ["xdg-open", [url] as string[]];
  try {
    const child = spawn(command as string, args as string[]);
    child.on("error", () => {});
    child.unref();
  } catch {
    // Browser launch is a convenience; never fail serve over it.
  }
}

/**
 * Locate the built web SPA relative to this module: `apps/web/dist` when
 * running from the repo (`src/` or `dist/`). Returns undefined when no build
 * exists — `trace serve` then runs API-only.
 */
export function resolveWebAssetsDir(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
  bundleDir: string | undefined = globalThis.__TRACE_BUNDLE_DIR__,
): string | undefined {
  if (bundleDir) {
    const bundledAssets = resolve(bundleDir, "web");
    if (existsSync(join(bundledAssets, "index.html"))) return bundledAssets;
  }

  const distAssets = resolve(moduleDir, "web");
  if (existsSync(join(distAssets, "index.html"))) return distAssets;

  const candidate = resolve(moduleDir, "../../web/dist");
  return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

/** Build the `trace serve` HTTP server bound to the resolved trace database. */
export function createTraceServeServer(
  env: Record<string, string | undefined>,
  assetsDir: string | undefined = resolveWebAssetsDir(),
): Server {
  return createServer(
    createServeRequestListener(
      resolveDatabasePath(env),
      assetsDir,
      Boolean(env.TRACE_SERVER_URL),
    ),
  );
}

/**
 * Start the server and resolve once it is listening. When the preferred port
 * is taken, falls back to the next consecutive port (up to
 * {@link PORT_FALLBACK_ATTEMPTS} tries).
 */
export function startTraceServe(
  env: Record<string, string | undefined>,
  options: StartTraceServeOptions = {},
): Promise<TraceServer> {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? DEFAULT_SERVE_PORT;
  const server = options.server ?? createTraceServeServer(env);

  // Fire-and-forget a sync as the board starts, so a freshly opened board
  // reflects other machines. No-ops instantly when logged out or offline.
  (options.triggerSync ?? triggerBackgroundSync)(env);

  return new Promise((resolve, reject) => {
    const listenOn = (port: number, attemptsLeft: number): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
          listenOn(port + 1, attemptsLeft - 1);
          return;
        }
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        const address = server.address();
        const boundPort =
          typeof address === "object" && address ? address.port : port;
        resolve({
          url: `http://${host}:${boundPort}/`,
          port: boundPort,
          close: () =>
            new Promise<void>((resolveClose, rejectClose) => {
              server.close((error) =>
                error ? rejectClose(error) : resolveClose(),
              );
            }),
        });
      });
    };

    listenOn(preferredPort, PORT_FALLBACK_ATTEMPTS);
  });
}
