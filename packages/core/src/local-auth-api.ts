import type { TraceApiResponse } from "./api-handler.ts";

/**
 * The machine-local authentication endpoints (`/api/local-auth/...`) the board
 * uses to sign this machine in and out.
 *
 * Authentication is machine-local: the *process serving the board* owns the
 * bearer token, not the browser. So these routes are a thin shell over a
 * host-supplied {@link LocalAuthService} — the host (`trace serve`) runs the
 * device authorization sequence and writes the credential files, and the board
 * only ever sees a {@link LoginAttemptView}. That view has no field for the
 * bearer token by construction, which is what keeps the token out of the
 * browser.
 *
 * The routing lives here, beside `handleTraceApiRequest`, so any host that
 * serves the board serves the same endpoints.
 */

/** Providers the hosted server can authenticate against. */
export type LoginProvider = "github" | "google";

/**
 * Where a login attempt has got to.
 *
 * - `waiting-for-approval` — the user must approve the device code in a browser
 * - `waiting-for-existing-key` — the account holds synced documents, so the
 *   existing document encryption key is required before credentials are stored
 * - `showing-generated-key` — a key was generated for an empty account and is
 *   being shown once for the user to save
 * - `complete` — credentials are stored and the machine is signed in
 * - `failed` / `expired` / `cancelled` — settled without signing in
 */
export type LoginAttemptState =
  | "waiting-for-approval"
  | "waiting-for-existing-key"
  | "showing-generated-key"
  | "complete"
  | "failed"
  | "expired"
  | "cancelled";

/**
 * Everything the board may know about a login attempt. Deliberately has no
 * bearer-token field: the token never leaves the serving process.
 *
 * `generatedKey` is the one secret that does cross to the browser, and only for
 * a freshly generated key on an empty account, only while the attempt is in
 * `showing-generated-key`, and only so the user can save it. The board keeps it
 * in component memory — never in storage, a URL, or a log.
 */
export interface LoginAttemptView {
  attemptId: string;
  state: LoginAttemptState;
  provider: LoginProvider;
  /** The hosted page the user must open to approve this device. */
  verificationUrl: string;
  userCode: string;
  /** A one-time document encryption key awaiting acknowledgement. */
  generatedKey?: string;
  /** The signed-in identity, once the attempt completes. */
  identity?: string;
  /** Why the attempt failed or expired. */
  error?: string;
}

/**
 * The host-side login machinery the routes drive. Implemented by the CLI
 * (`local-auth.ts` behind `trace serve`); a host that cannot authenticate — the
 * Vite dev middleware, say — simply passes no service and serves no
 * `/api/local-auth` routes.
 */
export interface LocalAuthService {
  startLogin(provider: LoginProvider): Promise<LoginAttemptView>;
  /** The current view of an attempt, or `null` when the serving process has
   * never heard of it (a restart, or a stale board tab). */
  readLogin(attemptId: string): LoginAttemptView | null;
  /** Confirm the user has saved a one-time generated key, which drops it from
   * the attempt and finishes the login. */
  acknowledgeGeneratedKey(attemptId: string): LoginAttemptView | null;
  /** Abandon an attempt. Explicit — closing the popover must not silently give
   * up on a device approval the user is still completing in another tab. */
  cancelLogin(attemptId: string): LoginAttemptView | null;
  /** Remove this machine's bearer token. */
  logout(): void;
}

const LOGIN_PATH = "/api/local-auth/login";

const PROVIDERS: readonly string[] = ["github", "google"];

/**
 * Route a `/api/local-auth/...` request, or return `null` when the request is
 * not one — so the host falls through to {@link handleTraceApiRequest}. Always
 * asynchronous: starting a login means talking to the hosted auth server.
 */
export function handleLocalAuthRequest(
  method: string,
  rawUrl: string,
  body: string | undefined,
  service: LocalAuthService,
): Promise<TraceApiResponse> | null {
  const path = (rawUrl.split("?", 1)[0] ?? rawUrl).replace(/\/$/, "");
  if (!path.startsWith("/api/local-auth")) return null;

  if (path === LOGIN_PATH) {
    if (method !== "POST") return resolved(methodNotAllowed());
    const provider = parseProvider(body);
    if (!provider) return resolved(badRequest("provider must be github or google"));
    return start(service, provider);
  }

  if (path === "/api/local-auth/logout") {
    if (method !== "POST") return resolved(methodNotAllowed());
    service.logout();
    return resolved(json({ ok: true }));
  }

  const actionMatch =
    /^\/api\/local-auth\/login\/([^/]+)\/(acknowledge-key|cancel)$/.exec(path);
  if (actionMatch?.[1] && actionMatch[2]) {
    if (method !== "POST") return resolved(methodNotAllowed());
    const attemptId = decodeURIComponent(actionMatch[1]);
    const attempt =
      actionMatch[2] === "cancel"
        ? service.cancelLogin(attemptId)
        : service.acknowledgeGeneratedKey(attemptId);
    return resolved(attempt ? json(attempt) : notFound());
  }

  const attemptMatch = /^\/api\/local-auth\/login\/([^/]+)$/.exec(path);
  if (attemptMatch?.[1]) {
    if (method !== "GET") return resolved(methodNotAllowed());
    const attempt = service.readLogin(decodeURIComponent(attemptMatch[1]));
    return resolved(attempt ? json(attempt) : notFound());
  }

  return resolved(notFound());
}

async function start(
  service: LocalAuthService,
  provider: LoginProvider,
): Promise<TraceApiResponse> {
  try {
    return json(await service.startLogin(provider));
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : String(error));
  }
}

/** Read the requested provider from a request body, defaulting to GitHub. */
function parseProvider(body: string | undefined): LoginProvider | null {
  if (!body) return "github";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { provider } = parsed as Record<string, unknown>;
  if (provider === undefined) return "github";
  return typeof provider === "string" && PROVIDERS.includes(provider)
    ? (provider as LoginProvider)
    : null;
}

function resolved(response: TraceApiResponse): Promise<TraceApiResponse> {
  return Promise.resolve(response);
}

function json(payload: unknown): TraceApiResponse {
  return {
    status: 200,
    body: JSON.stringify(payload),
    contentType: "application/json",
  };
}

function notFound(): TraceApiResponse {
  return { status: 404, body: "" };
}

function methodNotAllowed(): TraceApiResponse {
  return { status: 405, body: "" };
}

function badRequest(message: string): TraceApiResponse {
  return { status: 400, body: message };
}
