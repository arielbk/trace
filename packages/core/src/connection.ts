export const DEFAULT_HOSTED_WEB_ORIGIN = "https://app.eqnx.ai";

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
 * cross-origin allowlist, because a capability the runtime advertises but
 * refuses is a broken affordance, and a capability it grants but never
 * advertised is unreviewed authority.
 *
 * `account` and `sync` are narrower than their names suggest, and deliberately
 * so: the hosted board may run the sign-in that recovers existing work and read
 * how this machine's sync is doing, but it may not replace a document key,
 * receive a plaintext one, log the machine out, or command a sync run. The
 * server-side allowlist is where that narrowing is written down.
 */
export const HOSTED_CAPABILITIES: readonly TraceCapability[] = [
  "taskDetails",
  "taskMutations",
  "account",
  "sync",
];

/**
 * What a client must assume of a runtime that answers protocol 1 but advertises
 * no capabilities — one built before capability negotiation existed. Such a
 * runtime serves the original fixed cross-origin allowlist and nothing more, so
 * this set is frozen at what that allowlist was and must never track
 * {@link HOSTED_CAPABILITIES} again: widening the modern grant would otherwise
 * teach a client to call routes an old runtime answers with 403.
 */
export const LEGACY_HOSTED_CAPABILITIES: readonly TraceCapability[] = [
  "taskDetails",
  "taskMutations",
];

/** The deliberately small, database-free handshake exposed by local EQNX. */
export type TraceConnection = {
  service: "trace";
  protocolVersion: typeof TRACE_PROTOCOL_VERSION;
  /** The EQNX runtime answering, so a client can name it when reporting a
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
