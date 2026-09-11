import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import {
  handleLocalAuthRequest,
  handleTraceApiRequest,
  resolveAutoSyncEnabled,
  resolveConfiguredServerUrl,
  resolveDatabasePath,
  writeTraceApiResponse,
  DEFAULT_HOSTED_WEB_ORIGIN,
  TRACE_PROTOCOL_VERSION,
  type LocalAuthService,
  type TraceClientScope,
} from "@trace/core";
import { requestAutomaticSync } from "./commands/sync.ts";
import { resolvePackagedVersion } from "./commands/setup-operations.ts";
import { createLocalAuthService } from "./local-auth.ts";
import {
  createBridgePairingUrl,
  createPairingLinks,
  type PairingLinks,
} from "./bridge-pairing.ts";
import {
  openConnectionCredentials,
  type ConnectionCredentials,
} from "./connection-credentials.ts";
import { DEFAULT_SERVE_PORT } from "./connection-address.ts";

export { DEFAULT_SERVE_PORT } from "./connection-address.ts";

export type TraceServer = {
  url: string;
  pairingUrl?: string;
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
  /** Foreground serve may move to the next free port; the managed connection
   * may not, because the hosted board is configured against one address.
   * Defaults to true. */
  allowPortFallback?: boolean;
  /** Whether this process schedules the background sync that keeps an idle
   * board converging. Defaults to true; the managed connection turns it off in
   * a foreground serve so there is only ever one periodic sync owner. */
  periodicSync?: boolean;
  /**
   * Whether this process answers `/api/management/*` — how `eqnx connection
   * …` administers it, and how a probe recognises it as this installation's
   * own. The managed connection always sets it, because being administrable
   * must not depend on a hosted board being configured. Off by default, so
   * `eqnx serve` with hosted access disabled creates no unused credential.
   */
  localManagement?: boolean;
};

/** Exact hosted origin allowed to pair with and read this loopback API. */
export const TRACE_WEB_ORIGIN_ENV_VAR = "TRACE_WEB_ORIGIN";

/** How many consecutive ports to try when the preferred one is taken. */
const PORT_FALLBACK_ATTEMPTS = 10;

/** Debounce between a board mutation and the follow-up background sync, so a
 * burst of pins/archives coalesces into one sync shortly after it ends. */
export const MUTATION_SYNC_DELAY_MS = 5_000;

/** Minimum gap between focus-requested syncs (`POST /api/sync`). */
export const REQUEST_SYNC_MIN_INTERVAL_MS = 15_000;

/** How often the long-running serve process syncs in the background, keeping
 * an idle-but-open board's database converging with other machines. */
export const PERIODIC_SYNC_INTERVAL_MS = 5 * 60_000;

export type ServeSyncHooks = {
  onMutation: () => void;
  requestSync: () => void;
  onLoginComplete: () => void;
};

/**
 * Sync scheduling for the serve process: board mutations debounce into one
 * background sync shortly after the burst ends; explicit requests (the board
 * client on window focus) run immediately but at most once per
 * {@link REQUEST_SYNC_MIN_INTERVAL_MS}. The trigger itself no-ops when logged
 * out, so no path needs an auth check here.
 *
 * A completed login is the one case that neither schedules nor throttles: it
 * happens once, it is the moment the process stops being logged out, and the
 * user is watching. Making it share the request throttle would let the board's
 * own start-up sync swallow it.
 */
export function createSyncHooks(
  trigger: () => void,
  now: () => number = Date.now,
): ServeSyncHooks {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRequestedAt = -Infinity;
  return {
    onMutation: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        trigger();
      }, MUTATION_SYNC_DELAY_MS);
      timer.unref?.();
    },
    requestSync: () => {
      if (now() - lastRequestedAt < REQUEST_SYNC_MIN_INTERVAL_MS) return;
      lastRequestedAt = now();
      trigger();
    },
    onLoginComplete: trigger,
  };
}

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
 * The `eqnx serve` request handler. API routing goes through the shared
 * `@trace/core` router, so the served endpoints match the Vite dev middleware
 * exactly. Non-API requests are served from `assetsDir` (the built web SPA);
 * without an assets directory they get a 404.
 */
export function createServeRequestListener(
  databasePath: string,
  assetsDir?: string,
  syncServerConfigured?: boolean,
  syncHooks?: ServeSyncHooks,
  /** Reads the effective AutoSync mode; called per request because the user may
   * run `eqnx config set auto-sync` while the board is open. */
  resolveAutoSync?: () => boolean,
  /** Runs board-initiated login/logout. Absent means this host serves no
   * `/api/local-auth` routes. */
  localAuth?: LocalAuthService,
  /** Exact HTTPS origin allowed to call the local API cross-origin. */
  allowedWebOrigin?: string,
  /** This installation's credential store: the local management credential and
   * the per-browser credentials the hosted origin authenticates with. */
  connection?: ConnectionCredentials,
  /** Process-local, single-use exchanges that mint browser credentials. */
  pairing?: PairingLinks,
  /** The EQNX version this process is running, reported by the handshake. */
  runtimeVersion?: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (!isLoopbackHostHeader(req.headers?.host)) {
      res.statusCode = 421;
      res.end("Loopback Host required");
      return;
    }

    // Local management is answered ahead of the browser gates: it is not a
    // browser surface at all, and its own guard is stricter than theirs.
    if (
      handleManagementRequest(
        req,
        res,
        url,
        method,
        connection,
        pairing,
        allowedWebOrigin,
        runtimeVersion,
      )
    ) {
      return;
    }

    if (applyHostedApiCors(req, res, url, method, allowedWebOrigin)) return;
    if (
      rejectUnauthorizedHostedRequest(
        req,
        res,
        url,
        method,
        allowedWebOrigin,
        connection,
      )
    ) {
      return;
    }

    const dispatch = (body?: string): void => {
      if (
        handleBridgePairingRequest(
          res,
          url,
          method,
          body,
          pairing,
          req.headers?.origin,
          allowedWebOrigin,
        )
      ) {
        return;
      }

      // Auth routes are asynchronous (they reach the hosted server), so they
      // are routed ahead of the synchronous database API rather than through it.
      const authResponse = localAuth
        ? handleLocalAuthRequest(method, url, body, localAuth)
        : null;
      if (authResponse) {
        void authResponse.then((response) =>
          writeTraceApiResponse(res, response),
        );
        return;
      }

      const response = handleTraceApiRequest(databasePath, method, url, body, {
        syncServerConfigured,
        autoSyncEnabled: resolveAutoSync?.(),
        onMutation: syncHooks?.onMutation,
        requestSync: syncHooks?.requestSync,
        runtimeVersion,
        clientScope: hostedRequestScope(req, allowedWebOrigin),
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

/**
 * The authority a request carries, as the handshake should describe it. A
 * request that reached here bearing the hosted origin passed the cross-origin
 * allowlist and the bearer check, so it holds hosted authority and nothing
 * wider — the same-origin bundled board's own requests carry no Origin, or
 * carry this server's.
 */
function hostedRequestScope(
  req: IncomingMessage,
  allowedWebOrigin?: string,
): TraceClientScope {
  const requestOrigin = req.headers?.origin;
  return requestOrigin &&
    requestOrigin === allowedWebOrigin &&
    !isSameOriginRequest(req, requestOrigin)
    ? "hosted"
    : "same-origin";
}

/**
 * Grant browser access only to the configured hosted board. CORS is a browser
 * permission rather than authentication; bearer authorization and the one-time
 * pairing exchange remain separate checks below.
 */
function applyHostedApiCors(
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string,
  method: string,
  allowedWebOrigin?: string,
): boolean {
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  if (!path.startsWith("/api/")) return false;

  const requestOrigin = req.headers?.origin;
  if (!requestOrigin || isSameOriginRequest(req, requestOrigin)) return false;

  const isPairing = isPairingPath(path);
  // The one method each hosted path answers; anything unlisted has none, and
  // a hosted request using the other method is refused as if the path were.
  const hostedMethod = isPairing
    ? "POST"
    : isHostedReadPath(path)
      ? "GET"
      : isHostedActionPath(path)
        ? "POST"
        : undefined;

  // CORS alone does not prevent a cross-origin request from reaching the
  // server. Reject every non-local browser origin outside this deliberately
  // tiny method-and-path allowlist so the bridge cannot become a CSRF path.
  if (
    requestOrigin !== allowedWebOrigin ||
    !hostedMethod ||
    (method !== hostedMethod && method !== "OPTIONS")
  ) {
    res.statusCode = 403;
    res.end("Cross-origin API access denied");
    return true;
  }

  res.setHeader("access-control-allow-origin", requestOrigin);
  res.setHeader("vary", "Origin");
  if (method !== "OPTIONS") return false;

  const allowedMethod = hostedMethod;
  const allowedHeaders = hostedAllowedHeaders(path, isPairing);
  if (req.headers["access-control-request-method"] !== allowedMethod) {
    res.statusCode = 403;
    res.end("Cross-origin API access denied");
    return true;
  }

  const requestedHeaders = req.headers["access-control-request-headers"];
  const normalizedHeaders =
    typeof requestedHeaders === "string"
      ? requestedHeaders
          .split(",")
          .map((header) => header.trim().toLowerCase())
          .filter(Boolean)
      : [];
  // A subset rather than an exact match: a bodyless action need not announce a
  // content type. Anything outside the path's own list is still refused, so
  // this widens which requests preflight cleanly, never which headers are
  // allowed through.
  if (normalizedHeaders.some((header) => !allowedHeaders.includes(header))) {
    res.statusCode = 403;
    res.end("Cross-origin API access denied");
    return true;
  }

  res.setHeader("access-control-allow-methods", `${allowedMethod}, OPTIONS`);
  res.setHeader("access-control-allow-headers", allowedHeaders.join(", "));
  res.setHeader("access-control-max-age", "600");
  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("access-control-allow-private-network", "true");
  }
  res.statusCode = 204;
  res.end();
  return true;
}

/**
 * The request headers a hosted preflight may announce for this path. Pairing
 * predates browser credentials and carries only a JSON body; everything else
 * carries the browser credential. The restore login routes carry both, because
 * a provider choice and a document key are JSON request bodies — and they are
 * the only paths that get `content-type` alongside `authorization`, so
 * widening the account surface leaves the task surface exactly as narrow.
 */
function hostedAllowedHeaders(path: string, isPairing: boolean): string[] {
  if (isPairing) return ["content-type"];
  return isRestoreLoginActionPath(normalizePath(path))
    ? ["authorization", "content-type"]
    : ["authorization"];
}

function rejectUnauthorizedHostedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string,
  method: string,
  allowedWebOrigin?: string,
  connection?: ConnectionCredentials,
): boolean {
  if (!connection || method === "OPTIONS") return false;

  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  const requestOrigin = req.headers?.origin;
  if (
    !path.startsWith("/api/") ||
    (method === "POST" && isPairingPath(path)) ||
    !requestOrigin ||
    requestOrigin !== allowedWebOrigin ||
    isSameOriginRequest(req, requestOrigin)
  ) {
    return false;
  }

  const authorization = req.headers?.authorization;
  const supplied =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
  // Read through to the credential store on every request, so a revoked
  // browser loses access immediately rather than at the next restart.
  if (supplied && connection.verifyBrowserToken(supplied)) return false;

  res.statusCode = 401;
  res.setHeader("www-authenticate", "Bearer");
  res.end("Authorization required");
  return true;
}

/**
 * The read-only surface the hosted board may reach cross-origin: the connection
 * handshake, the task list, one task's timeline and docs, and the two reads the
 * restore journey needs — how this machine's sync is doing, and where a login
 * it started has got to. Exports and doc contents-by-hash stay local-only.
 */
function isHostedReadPath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    normalized === "/api/connection" ||
    normalized === "/api/tasks" ||
    /^\/api\/tasks\/[^/]+\/(timeline|docs)$/.test(normalized) ||
    normalized === "/api/sync/status" ||
    normalized === "/api/local-auth/transfers" ||
    isRestoreLoginReadPath(normalized)
  );
}

/**
 * The mutations the hosted board may perform cross-origin: archiving and
 * pinning a task, sign-out, and the login steps that recover existing work. Each
 * task action is reversible, carries no request body, and touches only the
 * task's own board metadata. Doc-checkbox writes, exports, and explicit sync
 * runs stay local-only.
 */
function isHostedActionPath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    /^\/api\/tasks\/[^/]+\/(archive|unarchive|pin|unpin)$/.test(normalized) ||
    normalized === "/api/local-auth/logout" ||
    isRestoreLoginActionPath(normalized)
  );
}

/**
 * Reading a login attempt: the one the board just started, or the one this
 * machine is still standing in the middle of. Neither view can carry the bearer
 * token by construction (see `LoginAttemptView`), which is what makes them safe
 * to answer to a remote origin at all.
 */
function isRestoreLoginReadPath(normalized: string): boolean {
  return (
    normalized === "/api/local-auth/login/current" ||
    /^\/api\/local-auth\/login\/[^/]+$/.test(normalized)
  );
}

/**
 * The writes that recover existing work: start a login, offer the account's
 * existing document key, give up on the attempt — and the two halves of being
 * let in by another machine instead of typing that key. The approval half
 * carries only a locator and a comparison code; the sealed envelope and the
 * document key itself never enter a response the board can read.
 *
 * The rest of `/api/local-auth` is deliberately absent, and the prefix is never
 * allowed wholesale. `replacement-key` makes an account's synced documents
 * permanently unreadable; `acknowledge-key` is the one response that carries a
 * plaintext document key, which must not cross to a remote origin. Sign-out is
 * granted separately in isHostedActionPath and carries no request body.
 */
function isRestoreLoginActionPath(normalized: string): boolean {
  return (
    normalized === "/api/local-auth/login" ||
    /^\/api\/local-auth\/login\/[^/]+\/(existing-key|cancel)$/.test(normalized) ||
    /^\/api\/local-auth\/login\/[^/]+\/transfer(\/cancel)?$/.test(normalized) ||
    /^\/api\/local-auth\/transfers\/[^/]+\/(open|approve|deny)$/.test(normalized)
  );
}

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Local management lives under one prefix so the browser gates below can stay
 * ignorant of it — nothing here is ever reachable from a page. */
const MANAGEMENT_PREFIX = "/api/management/";

/**
 * The local administration surface: issue a pairing link, list paired
 * browsers, revoke one, or revoke them all. It answers only to a request that
 * carries the local management credential and no browser origin at all, so a
 * paired browser — including the hosted board holding a valid browser
 * credential — can never administer this installation.
 */
function handleManagementRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string,
  method: string,
  connection?: ConnectionCredentials,
  pairing?: PairingLinks,
  allowedWebOrigin?: string,
  runtimeVersion?: string,
): boolean {
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  if (!path.startsWith(MANAGEMENT_PREFIX)) return false;

  res.setHeader("cache-control", "no-store");
  if (!connection) return endManagement(res, 404, "Management unavailable");

  // A browser announces itself with Origin (and browsers are the one client
  // this surface excludes), so its presence is disqualifying on its own — the
  // hosted origin and the bundled board included.
  if (req.headers?.origin !== undefined) {
    return endManagement(res, 403, "Management is local-only");
  }

  const authorization = req.headers?.authorization;
  const supplied =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
  if (!credentialsMatch(supplied, connection.managementToken)) {
    res.statusCode = 401;
    res.setHeader("www-authenticate", "Bearer");
    res.end("Local management authorization required");
    return true;
  }

  const route = path.slice(MANAGEMENT_PREFIX.length);
  // Answering this at all is the proof of ownership: only the holder of this
  // installation's management credential gets here, so a reply means the
  // process on the endpoint is *ours*, not merely some EQNX.
  if (route === "status" && method === "GET") {
    return endManagementJson(res, 200, {
      service: "trace",
      protocolVersion: TRACE_PROTOCOL_VERSION,
      runtimeVersion: runtimeVersion ?? "0.0.0",
      pid: process.pid,
    });
  }

  if (route === "browsers" && method === "GET") {
    return endManagementJson(res, 200, { browsers: connection.listBrowsers() });
  }

  if (route === "pairings" && method === "POST") {
    if (!pairing) return endManagement(res, 409, "Pairing unavailable");
    const link = pairing.create();
    return endManagementJson(res, 200, {
      secret: link.secret,
      expiresAt: link.expiresAt,
      url: allowedWebOrigin
        ? createBridgePairingUrl(allowedWebOrigin, link.secret)
        : undefined,
    });
  }

  const approving = /^pairings\/([A-F0-9]{4}-[A-F0-9]{4})\/approve$/.exec(
    route,
  );
  if (approving && method === "POST") {
    return pairing?.approve(approving[1]!)
      ? endManagementJson(res, 200, { approved: true })
      : endManagementJson(res, 410, { approved: false });
  }

  if (route === "reset" && method === "POST") {
    const revoked = connection.listBrowsers().length;
    connection.reset();
    pairing?.clear();
    return endManagementJson(res, 200, { revoked });
  }

  const revoking = /^browsers\/([^/]+)\/revoke$/.exec(route);
  if (revoking && method === "POST") {
    const id = decodeURIComponent(revoking[1] as string);
    return connection.revokeBrowser(id)
      ? endManagementJson(res, 200, { revoked: true })
      : endManagementJson(res, 404, { revoked: false });
  }

  return endManagement(res, 404, "No such management route");
}

function endManagement(
  res: ServerResponse,
  statusCode: number,
  message: string,
): true {
  res.statusCode = statusCode;
  res.end(message);
  return true;
}

function endManagementJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): true {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
  return true;
}

function isPairingPath(path: string): boolean {
  return (
    path === "/api/pairing" ||
    path === "/api/pairing/" ||
    path === "/api/pairing/requests" ||
    path === "/api/pairing/requests/poll"
  );
}

function handleBridgePairingRequest(
  res: ServerResponse,
  rawUrl: string,
  method: string,
  body: string | undefined,
  pairing?: PairingLinks,
  requestOrigin?: string,
  allowedWebOrigin?: string,
): boolean {
  const path = rawUrl.split("?", 1)[0] ?? rawUrl;
  if (!isPairingPath(path) || method !== "POST") return false;

  if (path.startsWith("/api/pairing/requests")) {
    res.setHeader("cache-control", "no-store");
    if (!allowedWebOrigin || requestOrigin !== allowedWebOrigin) {
      return endManagement(res, 403, "Hosted origin required");
    }
    if (!pairing) return endManagement(res, 409, "Pairing unavailable");
    if (path === "/api/pairing/requests") {
      const request = pairing.request();
      return request
        ? endManagementJson(res, 201, request)
        : endManagement(
            res,
            429,
            "Too many pending requests. Try again in a few minutes.",
          );
    }
    let secret = "";
    try {
      const payload = JSON.parse(body ?? "") as { secret?: unknown };
      if (typeof payload.secret === "string") secret = payload.secret;
    } catch {
      /* Invalid and expired requests have the same response. */
    }
    const result = pairing.poll(secret);
    return result
      ? endManagementJson(res, result.status === "pending" ? 202 : 200, result)
      : endManagement(res, 410, "Pairing request expired or already used");
  }

  let secret = "";
  try {
    const payload = JSON.parse(body ?? "") as { secret?: unknown };
    if (typeof payload.secret === "string") secret = payload.secret;
  } catch {
    // Malformed and missing secrets share the same non-oracular response.
  }
  const credential = pairing?.exchange(secret);
  res.setHeader("cache-control", "no-store");
  if (!credential) {
    res.statusCode = 401;
    res.end("Pairing secret invalid or already used");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ token: credential }));
  return true;
}

function credentialsMatch(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function isSameOriginRequest(
  req: IncomingMessage,
  requestOrigin: string,
): boolean {
  const host = req.headers?.host;
  return Boolean(
    host &&
    (requestOrigin === `http://${host}` || requestOrigin === `https://${host}`),
  );
}

function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(
    host,
  );
  if (!match) return false;
  if (!match[2]) return true;
  const port = Number(match[2]);
  return port > 0 && port <= 65_535;
}

function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Return one canonical origin, or undefined when hosted access is disabled. */
export function resolveAllowedWebOrigin(
  env: Record<string, string | undefined>,
): string | undefined {
  const configured = (
    env[TRACE_WEB_ORIGIN_ENV_VAR] ?? DEFAULT_HOSTED_WEB_ORIGIN
  ).trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
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

/**
 * Locate the built web SPA relative to this module: `apps/web/dist` when
 * running from the repo (`src/` or `dist/`). Returns undefined when no build
 * exists — `eqnx serve` then runs API-only.
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

/** Build the `eqnx serve` HTTP server bound to the resolved trace database. */
export function createTraceServeServer(
  env: Record<string, string | undefined>,
  assetsDir: string | undefined = resolveWebAssetsDir(),
  syncHooks?: ServeSyncHooks,
  bridgeAccess?: BridgeAccess,
): Server {
  const allowedWebOrigin = resolveAllowedWebOrigin(env);
  const access =
    bridgeAccess ?? (allowedWebOrigin ? createBridgeAccess(env) : undefined);
  return createServer(
    createServeRequestListener(
      resolveDatabasePath(env),
      assetsDir,
      Boolean(resolveConfiguredServerUrl(env)),
      syncHooks,
      () => resolveAutoSyncEnabled(env),
      // Signing in is a mutation of what this machine can see, so it belongs on
      // the same sync trigger the board's mutations already use.
      createLocalAuthService(env, {
        onLoginComplete: syncHooks?.onLoginComplete,
      }),
      allowedWebOrigin,
      access?.connection,
      access?.pairing,
      env.TRACE_CURRENT_VERSION ?? resolvePackagedVersion(),
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
  if (!isLoopbackBindHost(host)) {
    return Promise.reject(
      new Error("eqnx serve must bind to a loopback host"),
    );
  }
  const preferredPort = options.port ?? DEFAULT_SERVE_PORT;
  const triggerSync = options.triggerSync ?? requestAutomaticSync;
  const allowedWebOrigin = resolveAllowedWebOrigin(env);
  const bridgeAccess =
    allowedWebOrigin || options.localManagement
      ? createBridgeAccess(env)
      : undefined;
  // Foreground serve opens with one link in hand, the way it always has; the
  // running service can mint more on request without restarting.
  const pairingUrl =
    allowedWebOrigin && bridgeAccess
      ? createBridgePairingUrl(
          allowedWebOrigin,
          bridgeAccess.pairing.create().secret,
        )
      : undefined;
  const server =
    options.server ??
    createTraceServeServer(
      env,
      undefined,
      createSyncHooks(() => triggerSync(env)),
      bridgeAccess,
    );

  // Fire-and-forget a sync as the board starts, so a freshly opened board
  // reflects other machines. No-ops instantly when logged out or offline.
  triggerSync(env);

  // Between mutations, keep an idle-but-open board converging with other
  // machines. unref'd so the timer never holds the process alive on its own.
  // Skipped when another process already owns periodic sync, so coexisting
  // runtimes never double the sync rate.
  const periodicSync =
    options.periodicSync === false
      ? undefined
      : setInterval(() => triggerSync(env), PERIODIC_SYNC_INTERVAL_MS);
  periodicSync?.unref?.();

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
          url: `http://${host === "::1" ? `[${host}]` : host}:${boundPort}/`,
          pairingUrl,
          port: boundPort,
          close: () =>
            new Promise<void>((resolveClose, rejectClose) => {
              if (periodicSync) clearInterval(periodicSync);
              server.close((error) =>
                error ? rejectClose(error) : resolveClose(),
              );
            }),
        });
      });
    };

    listenOn(
      preferredPort,
      options.allowPortFallback === false ? 0 : PORT_FALLBACK_ATTEMPTS,
    );
  });
}

/** The credential store plus this process's outstanding pairing links. */
export type BridgeAccess = {
  connection: ConnectionCredentials;
  pairing: PairingLinks;
};

function createBridgeAccess(
  env: Record<string, string | undefined>,
): BridgeAccess {
  const connection = openConnectionCredentials(env);
  return {
    connection,
    pairing: createPairingLinks((label) => connection.issueBrowserToken(label)),
  };
}
