export const TRACE_PROTOCOL_VERSION = 1;

/**
 * The named operations a client may perform against the local API. The names
 * are the handshake's vocabulary: the runtime advertises the subset a given
 * client's authority actually permits, and the client gates both its calls and
 * its visible affordances on that subset rather than on its own assumptions.
 */
export type TraceCapability =
  | "taskDetails"
  | "taskMutations"
  | "docEdits"
  | "taskExports"
  | "account"
  | "sync";

/**
 * Which authority a request arrived with. `same-origin` is the bundled board
 * served by this process; `hosted` is the configured remote board reaching the
 * loopback API cross-origin with a paired browser credential.
 */
export type TraceClientScope = "same-origin" | "hosted";

/** Everything the bundled board, served by this very process, may do. */
export const SAME_ORIGIN_CAPABILITIES: readonly TraceCapability[] = [
  "taskDetails",
  "taskMutations",
  "docEdits",
  "taskExports",
  "account",
  "sync",
];

/**
 * What the hosted board may do. This must stay identical to the server-side
 * cross-origin allowlist — reads plus archive/unarchive/pin/unpin — because a
 * capability the runtime advertises but refuses is a broken affordance, and a
 * capability it grants but never advertised is unreviewed authority.
 */
export const HOSTED_CAPABILITIES: readonly TraceCapability[] = [
  "taskDetails",
  "taskMutations",
];

/** The deliberately small, database-free handshake exposed by local Trace. */
export type TraceConnection = {
  service: "trace";
  protocolVersion: typeof TRACE_PROTOCOL_VERSION;
  /** The Trace runtime answering, so a client can name it when reporting a
   * mismatch. Informational: the protocol version is the compatibility gate.
   * Optional on the wire, because a runtime predating capability negotiation
   * sends neither field and a client must still read what it did send. */
  runtimeVersion?: string;
  capabilities?: readonly TraceCapability[];
};

export function traceConnection(options?: {
  runtimeVersion?: string;
  scope?: TraceClientScope;
}): TraceConnection {
  return {
    service: "trace",
    protocolVersion: TRACE_PROTOCOL_VERSION,
    runtimeVersion: options?.runtimeVersion ?? "0.0.0",
    capabilities:
      options?.scope === "hosted"
        ? HOSTED_CAPABILITIES
        : SAME_ORIGIN_CAPABILITIES,
  };
}
