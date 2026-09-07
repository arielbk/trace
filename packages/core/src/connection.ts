export const TRACE_PROTOCOL_VERSION = 1;

/** The deliberately small, database-free handshake exposed by local Trace. */
export type TraceConnection = {
  service: "trace";
  protocolVersion: typeof TRACE_PROTOCOL_VERSION;
};

export function traceConnection(): TraceConnection {
  return {
    service: "trace",
    protocolVersion: TRACE_PROTOCOL_VERSION,
  };
}
