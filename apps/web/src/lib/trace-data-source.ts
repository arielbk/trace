import {
  TRACE_PROTOCOL_VERSION,
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
  sync: boolean;
}>;

export interface TraceDataSource {
  readonly key: string;
  readonly protocolVersion: number;
  readonly capabilities: TraceDataSourceCapabilities;
  readonly connectAutomatically: boolean;
  request(path: string, init?: RequestInit): Promise<Response>;
  connect(): Promise<TraceConnection>;
}

const SAME_ORIGIN_CAPABILITIES: TraceDataSourceCapabilities = {
  requiresConnection: false,
  taskDetails: true,
  taskMutations: true,
  docEdits: true,
  taskExports: true,
  account: true,
  sync: true,
};

// The bridge's cross-origin allowlist is narrower than the bundled board's:
// tasks can be archived and pinned, but doc edits and exports stay local-only,
// so the hosted UI must not offer affordances the loopback API would refuse.
const LOCAL_CAPABILITIES: TraceDataSourceCapabilities = {
  requiresConnection: true,
  taskDetails: true,
  taskMutations: true,
  docEdits: false,
  taskExports: false,
  account: false,
  sync: false,
};

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
  readonly capabilities = LOCAL_CAPABILITIES;
  readonly origin: string;
  readonly credentialStorageKey: string;
  #credential: string | null;

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
    if (!this.#credential) return traceApiFetch(path, init, this.origin);

    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.#credential}`);
    return traceApiFetch(path, { ...init, headers }, this.origin);
  }

  get connectAutomatically(): boolean {
    return Boolean(this.#credential || readPairingSecret());
  }

  override async connect(): Promise<TraceConnection> {
    const pairingSecret = readPairingSecret();
    if (pairingSecret) {
      try {
        await this.#pair(pairingSecret);
      } finally {
        removePairingSecret();
      }
    }
    return super.connect();
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
      throw new Error("Trace returned an invalid bridge credential");
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
