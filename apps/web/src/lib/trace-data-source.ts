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
  taskMutations: boolean;
  account: boolean;
  sync: boolean;
}>;

export interface TraceDataSource {
  readonly key: string;
  readonly protocolVersion: number;
  readonly capabilities: TraceDataSourceCapabilities;
  request(path: string, init?: RequestInit): Promise<Response>;
  connect(): Promise<TraceConnection>;
}

const SAME_ORIGIN_CAPABILITIES: TraceDataSourceCapabilities = {
  requiresConnection: false,
  taskDetails: true,
  taskMutations: true,
  account: true,
  sync: true,
};

const LOCAL_CAPABILITIES: TraceDataSourceCapabilities = {
  requiresConnection: true,
  taskDetails: false,
  taskMutations: false,
  account: false,
  sync: false,
};

abstract class HttpTraceDataSource implements TraceDataSource {
  readonly protocolVersion = TRACE_PROTOCOL_VERSION;
  abstract readonly key: string;
  abstract readonly capabilities: TraceDataSourceCapabilities;

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

  request(path: string, init?: RequestInit): Promise<Response> {
    return traceApiFetch(path, init, "");
  }
}

export class LocalTraceSource extends HttpTraceDataSource {
  readonly key: string;
  readonly capabilities = LOCAL_CAPABILITIES;
  readonly origin: string;

  constructor(origin: string) {
    super();
    this.origin = resolveTraceApiOrigin(origin);
    if (!this.origin) {
      throw new Error("LocalTraceSource requires a local API origin");
    }
    this.key = `local:${this.origin}`;
  }

  request(path: string, init?: RequestInit): Promise<Response> {
    return traceApiFetch(path, init, this.origin);
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
