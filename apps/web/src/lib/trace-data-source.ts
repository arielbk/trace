import {
  LEGACY_HOSTED_CAPABILITIES,
  TRACE_PROTOCOL_VERSION,
  type TraceCapability,
  type TraceConnection,
} from "@trace/core/browser";
import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import {
  resolveTraceApiOrigin,
  traceApiFetch,
  traceApiOrigin,
} from "./api-origin.ts";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Thrown when the board asks a local connection for something the connected
 * runtime never granted. It is not an HTTP failure: the request is refused
 * before it leaves the browser, so a withheld capability cannot be reached by
 * calling past a hidden control.
 */
export class UnsupportedOperationError extends Error {
  constructor(public readonly capability: TraceCapability) {
    super(`EQNX on this device did not grant "${capability}"`);
    this.name = "UnsupportedOperationError";
  }
}

export type TraceDataSourceCapabilities = Readonly<{
  requiresConnection: boolean;
  taskDetails: boolean;
  /** Archive, unarchive, pin, and unpin — a task's own board metadata. */
  taskMutations: boolean;
  /** Doc checkbox writes, which change files on the machine's disk. */
  docEdits: boolean;
  /** Export downloads, which pull whole tasks and transcripts out at once. */
  taskExports: boolean;
  account: boolean;
  accountSignOut: boolean;
  sync: boolean;
  /** Being unlocked by another of the account's machines, and unlocking one —
   * the alternative to typing a recovery key. */
  keyTransfer: boolean;
}>;

export interface TraceDataSource {
  readonly key: string;
  readonly protocolVersion: number;
  readonly capabilities: TraceDataSourceCapabilities;
  readonly connectAutomatically: boolean;
  request(path: string, init?: RequestInit): Promise<Response>;
  connect(): Promise<TraceConnection>;
  beginPairing?(
    signal: AbortSignal,
  ): Promise<{ code: string; secret: string; expiresAt: number }>;
  pollPairing?(secret: string, signal: AbortSignal): Promise<boolean>;
}

const SAME_ORIGIN_CAPABILITIES: TraceDataSourceCapabilities = {
  requiresConnection: false,
  taskDetails: true,
  taskMutations: true,
  docEdits: true,
  taskExports: true,
  account: true,
  accountSignOut: true,
  sync: true,
  keyTransfer: true,
};

/**
 * What a local connection may do before — or absent — a capability handshake.
 * A protocol-1 runtime predating capability advertisement answers a fixed
 * cross-origin allowlist: reads plus archive/unarchive/pin/unpin. Assuming that
 * and no more keeps a legacy runtime working without inventing authority a
 * newer runtime might have declined to grant — and, just as importantly,
 * without offering the user an account or sync control that such a runtime
 * would answer with a flat refusal.
 */
const LEGACY_LOCAL_CAPABILITIES: TraceDataSourceCapabilities = localCapabilities(
  LEGACY_HOSTED_CAPABILITIES,
);

/** Widen the handshake's capability names into the board's capability flags. */
function localCapabilities(
  advertised: readonly TraceCapability[],
): TraceDataSourceCapabilities {
  const granted = new Set(advertised);
  return {
    requiresConnection: true,
    taskDetails: granted.has("taskDetails"),
    taskMutations: granted.has("taskMutations"),
    docEdits: granted.has("docEdits"),
    taskExports: granted.has("taskExports"),
    account: granted.has("account"),
    accountSignOut: granted.has("accountSignOut"),
    sync: granted.has("sync"),
    keyTransfer: granted.has("keyTransfer"),
  };
}

/**
 * The capability list a runtime advertised, or null when it advertised none in
 * a form this board can trust. Unknown names are dropped rather than rejected:
 * a newer runtime naming a capability this board has never heard of is not a
 * broken handshake, it is simply an affordance this board cannot offer.
 */
function readAdvertisedCapabilities(
  connection: TraceConnection,
): readonly TraceCapability[] | null {
  // Capability names are this protocol version's vocabulary. A runtime that
  // answers a different protocol may mean something else by them, so its list
  // is not read at all — the caller reports the mismatch instead.
  if (connection?.protocolVersion !== TRACE_PROTOCOL_VERSION) return null;
  const advertised: unknown = connection.capabilities;
  if (!Array.isArray(advertised)) return null;
  return advertised.filter(
    (capability): capability is TraceCapability =>
      typeof capability === "string" && KNOWN_CAPABILITIES.has(capability),
  );
}

/**
 * The capability each API path needs, so a call is gated by the same handshake
 * that gates the affordance. The task list and the handshake itself are the
 * base of every connection and need none. Order matters: a doc checkbox write
 * lives under the docs path but is an edit, not a read.
 */
function requiredCapability(path: string): TraceCapability | null {
  const route = path.split("?", 1)[0] ?? path;
  if (/^\/api\/tasks\/[^/]+\/docs\/checkbox$/.test(route)) return "docEdits";
  if (/^\/api\/tasks\/[^/]+\/export$/.test(route)) return "taskExports";
  if (/^\/api\/tasks\/[^/]+\/(archive|unarchive|pin|unpin)$/.test(route)) {
    return "taskMutations";
  }
  if (/^\/api\/tasks\/[^/]+\/(timeline|docs)$/.test(route)) {
    return "taskDetails";
  }
  if (route === "/api/sync" || route.startsWith("/api/sync/")) return "sync";
  // Ahead of the `account` catch-all below: a runtime that grants account
  // routes may still predate key transfer, and a board must not offer an
  // approval control such a runtime would refuse.
  if (
    route === "/api/local-auth/transfers" ||
    route.startsWith("/api/local-auth/transfers/") ||
    /^\/api\/local-auth\/login\/[^/]+\/transfer(\/cancel)?$/.test(route)
  ) {
    return "keyTransfer";
  }
  if (route === "/api/local-auth/logout") return "accountSignOut";
  if (route === "/api/config" || route.startsWith("/api/local-auth")) {
    return "account";
  }
  return null;
}

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  "taskDetails",
  "taskMutations",
  "docEdits",
  "taskExports",
  "account",
  "accountSignOut",
  "sync",
  "keyTransfer",
]);

abstract class HttpTraceDataSource implements TraceDataSource {
  readonly protocolVersion = TRACE_PROTOCOL_VERSION;
  abstract readonly key: string;
  abstract readonly capabilities: TraceDataSourceCapabilities;
  abstract readonly connectAutomatically: boolean;

  abstract request(path: string, init?: RequestInit): Promise<Response>;

  async connect(): Promise<TraceConnection> {
    const response = await this.request("/api/connection");
    if (!response.ok) {
      throw new HttpError(
        response.status,
        `GET /api/connection failed: ${response.status}`,
      );
    }
    return response.json() as Promise<TraceConnection>;
  }
}

export class SameOriginTraceSource extends HttpTraceDataSource {
  readonly key = "same-origin";
  readonly capabilities = SAME_ORIGIN_CAPABILITIES;
  readonly connectAutomatically = false;

  request(path: string, init?: RequestInit): Promise<Response> {
    return traceApiFetch(path, init, "");
  }
}

export class LocalTraceSource extends HttpTraceDataSource {
  readonly key: string;
  readonly origin: string;
  readonly credentialStorageKey: string;
  #credential: string | null;
  #capabilities: TraceDataSourceCapabilities = LEGACY_LOCAL_CAPABILITIES;

  constructor(origin: string) {
    super();
    this.origin = resolveTraceApiOrigin(origin);
    if (!this.origin) {
      throw new Error("LocalTraceSource requires a local API origin");
    }
    this.key = `local:${this.origin}`;
    this.credentialStorageKey = `trace.bridgeCredential:${this.origin}`;
    this.#credential = readStoredCredential(this.credentialStorageKey);
  }

  request(path: string, init?: RequestInit): Promise<Response> {
    const capability = requiredCapability(path);
    if (capability && !this.#capabilities[capability]) {
      return Promise.reject(new UnsupportedOperationError(capability));
    }
    if (!this.#credential) return traceApiFetch(path, init, this.origin);

    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.#credential}`);
    return traceApiFetch(path, { ...init, headers }, this.origin);
  }

  get connectAutomatically(): boolean {
    return Boolean(
      this.#credential ||
      readStoredCredential(this.credentialStorageKey) ||
      readPairingSecret(),
    );
  }

  /** What the connected runtime granted; the conservative legacy set until a
   * handshake says otherwise. */
  get capabilities(): TraceDataSourceCapabilities {
    return this.#capabilities;
  }

  override async connect(): Promise<TraceConnection> {
    // Another tab may have completed pairing while this source stayed mounted.
    this.#credential =
      readStoredCredential(this.credentialStorageKey) ?? this.#credential;
    const pairingSecret = readPairingSecret();
    if (pairingSecret) {
      try {
        await this.#pair(pairingSecret);
      } finally {
        removePairingSecret();
      }
    }
    const connection = await super.connect();
    const advertised = readAdvertisedCapabilities(connection);
    this.#capabilities = advertised
      ? localCapabilities(advertised)
      : LEGACY_LOCAL_CAPABILITIES;
    return connection;
  }

  async beginPairing(signal: AbortSignal) {
    const response = await traceApiFetch(
      "/api/pairing/requests",
      { method: "POST", signal },
      this.origin,
    );
    if (!response.ok)
      throw new HttpError(response.status, "Could not prepare pairing");
    const payload = await response.json();
    if (
      !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(payload.code) ||
      typeof payload.secret !== "string" ||
      !TOKEN_PATTERN.test(payload.secret) ||
      typeof payload.expiresAt !== "number" ||
      !Number.isFinite(payload.expiresAt)
    ) {
      throw new Error("EQNX returned an invalid pairing request");
    }
    return payload as { code: string; secret: string; expiresAt: number };
  }

  async pollPairing(secret: string, signal: AbortSignal): Promise<boolean> {
    const response = await traceApiFetch(
      "/api/pairing/requests/poll",
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret }),
      },
      this.origin,
    );
    if (!response.ok)
      throw new HttpError(response.status, "Could not complete pairing");
    const payload = await response.json();
    if (response.status === 202 && payload.status === "pending") return false;
    if (
      payload.status !== "approved" ||
      typeof payload.token !== "string" ||
      !TOKEN_PATTERN.test(payload.token)
    ) {
      throw new Error("EQNX returned an invalid bridge credential");
    }
    if (signal.aborted) return false;
    this.#credential = payload.token;
    writeStoredCredential(this.credentialStorageKey, payload.token);
    return true;
  }

  async #pair(secret: string): Promise<void> {
    const response = await traceApiFetch(
      "/api/pairing",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret }),
      },
      this.origin,
    );
    if (!response.ok) {
      throw new HttpError(
        response.status,
        `POST /api/pairing failed: ${response.status}`,
      );
    }

    const payload = (await response.json()) as { token?: unknown };
    if (
      typeof payload.token !== "string" ||
      !TOKEN_PATTERN.test(payload.token)
    ) {
      throw new Error("EQNX returned an invalid bridge credential");
    }
    this.#credential = payload.token;
    writeStoredCredential(this.credentialStorageKey, payload.token);
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_FRAGMENT_KEY = "trace-pair";

function readPairingSecret(): string | null {
  if (typeof window === "undefined") return null;
  const secret = new URLSearchParams(window.location.hash.slice(1)).get(
    PAIRING_FRAGMENT_KEY,
  );
  return secret && TOKEN_PATTERN.test(secret) ? secret : null;
}

function removePairingSecret(): void {
  if (typeof window === "undefined") return;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has(PAIRING_FRAGMENT_KEY)) return;
  fragment.delete(PAIRING_FRAGMENT_KEY);
  const remaining = fragment.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`,
  );
}

function readStoredCredential(key: string): string | null {
  try {
    const token = globalThis.localStorage?.getItem(key);
    return token && TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

function writeStoredCredential(key: string, token: string): void {
  try {
    globalThis.localStorage?.setItem(key, token);
  } catch {
    // Keep the in-memory credential for this visit when storage is unavailable.
  }
}

export function createTraceDataSource(origin: string): TraceDataSource {
  const configuredOrigin = resolveTraceApiOrigin(origin);
  return configuredOrigin
    ? new LocalTraceSource(configuredOrigin)
    : new SameOriginTraceSource();
}

export const defaultTraceDataSource = createTraceDataSource(traceApiOrigin);

const TraceDataSourceContext = createContext<TraceDataSource>(
  defaultTraceDataSource,
);

export function TraceDataSourceProvider({
  source,
  children,
}: {
  source: TraceDataSource;
  children?: ReactNode;
}) {
  return createElement(
    TraceDataSourceContext.Provider,
    { value: source },
    children,
  );
}

export function useTraceDataSource(): TraceDataSource {
  return useContext(TraceDataSourceContext);
}
