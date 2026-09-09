import { Cable, Check, Loader2, TriangleAlert } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_HOSTED_WEB_ORIGIN,
  TRACE_PROTOCOL_VERSION,
  type TraceConnection,
} from "@trace/core/browser";
import { HttpError, useTraceDataSource } from "../lib/trace-data-source.ts";
import { useConnectionHealth } from "../lib/connection-recovery.ts";
import { BrowserPairing } from "./BrowserPairing.tsx";
import { AppHeader } from "./AppHeader.tsx";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/Dropdown.tsx";

type ConnectionState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "connected" }
  | { phase: "failed"; failure: ConnectionFailure };

export type ConnectionFailure = {
  kind: "unavailable" | "unpaired" | "blocked" | "incompatible";
  /** The uppercase eyebrow above the headline, in the board's section voice. */
  eyebrow: string;
  title: string;
  description: string;
};

export function supportsLocalTraceBridge(userAgent: string): boolean {
  const mobileApple = /\b(iPhone|iPad|iPod)\b/i.test(userAgent);
  const safari =
    /Safari\//i.test(userAgent) &&
    !/(Chrome|Chromium|CriOS|Edg|FxiOS)\//i.test(userAgent);
  return !mobileApple && !safari;
}

export function validateTraceConnection(
  connection: TraceConnection,
): ConnectionFailure | null {
  if (
    connection?.service !== "trace" ||
    typeof connection.protocolVersion !== "number"
  ) {
    return {
      kind: "incompatible",
      eyebrow: "Incompatible",
      title: "This Trace connection isn’t compatible",
      description:
        "The service on this device did not return a valid Trace handshake. Update Trace, then try again.",
    };
  }

  if (connection.protocolVersion !== TRACE_PROTOCOL_VERSION) {
    return {
      kind: "incompatible",
      eyebrow: "Incompatible",
      title: "Trace needs an update",
      description:
        connection.protocolVersion < TRACE_PROTOCOL_VERSION
          ? "The Trace version on this device is too old for this site. Update Trace, restart it, then try again."
          : "The Trace version on this device uses a newer connection protocol than this site supports. Reload this site and try again.",
    };
  }

  return null;
}

export function connectionFailure(error: unknown): ConnectionFailure {
  // A 401 is Trace answering, so it is the one failure the viewer cannot fix by
  // starting Trace or granting network access — this browser simply holds no
  // bridge credential, and only a fresh pairing link mints one.
  if (error instanceof HttpError && error.status === 401) {
    return {
      kind: "unpaired",
      eyebrow: "Not paired",
      title: "This browser isn’t paired with Trace",
      description:
        "Trace is running on this device but has not given this browser access. Run `trace connection pair` on this device and open the pairing link it prints to connect.",
    };
  }

  if (error instanceof HttpError && error.status === 403) {
    return {
      kind: "blocked",
      eyebrow: "Blocked",
      title: "Trace blocked this site",
      description:
        "This hosted address is not allowed to read Trace on this device. Update or restart Trace, then try again.",
    };
  }

  return {
    kind: "unavailable",
    eyebrow: "Not reachable",
    title: "Trace isn’t reachable",
    description:
      "Make sure Trace is running on this device. If your browser asks for local-network access, allow it, then try again.",
  };
}

/**
 * The one page-level primary on the hosted board. It wears the same accent-soft
 * weight the account popover's primary uses rather than a filled accent button:
 * a solid accent block appears nowhere else in the board and read as a
 * different product sitting on the same page.
 */
const PRIMARY_ACTION =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-control border border-transparent bg-accent-soft px-4 py-2 text-caption font-semibold text-accent transition-colors cursor-pointer hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60";

/** Section eyebrow, the board's heading for every block above a body. */
const EYEBROW = "m-0 text-xs font-bold uppercase tracking-widest";

/**
 * The gate in front of the hosted board: it explains the local connection, asks
 * for it once, and reports why it could not be made.
 *
 * It is laid out as an ordinary board page rather than a centred splash — the
 * same left column, title scale, and subtitle rhythm the task list uses — so a
 * viewer who lands here first sees the product they are about to enter.
 */
export function LocalTraceConnection({
  children,
  connect,
  userAgent = navigator.userAgent,
}: {
  children: ReactNode;
  connect?: () => Promise<TraceConnection>;
  userAgent?: string;
}) {
  const source = useTraceDataSource();
  const supported = supportsLocalTraceBridge(userAgent);
  const [state, setState] = useState<ConnectionState>({ phase: "idle" });
  const origin = bridgeOrigin(source);
  const setupCommand =
    window.location.origin === DEFAULT_HOSTED_WEB_ORIGIN
      ? "trace setup"
      : `TRACE_WEB_ORIGIN='${window.location.origin.replaceAll("'", "'\\''")}' trace setup`;

  const attemptedAutomaticConnection = useRef(false);
  const handleConnect = useCallback(async () => {
    attemptedAutomaticConnection.current = true;
    setState({ phase: "connecting" });
    try {
      const connection = await (connect ? connect() : source.connect());
      const failure = validateTraceConnection(connection);
      setState(failure ? { phase: "failed", failure } : { phase: "connected" });
    } catch (error) {
      setState({ phase: "failed", failure: connectionFailure(error) });
    }
  }, [connect, source]);

  useEffect(() => {
    if (
      supported &&
      source.connectAutomatically &&
      !attemptedAutomaticConnection.current
    ) {
      attemptedAutomaticConnection.current = true;
      void handleConnect();
    }
  }, [handleConnect, source.connectAutomatically, supported]);

  useEffect(() => {
    if (!supported) return;
    // Opening a pairing link in this tab may change only the URL fragment,
    // leaving this gate mounted. Treat that link like an initial paired visit.
    const onPairingLink = () => {
      if (
        new URLSearchParams(window.location.hash.slice(1)).has("trace-pair") &&
        source.connectAutomatically
      ) {
        void handleConnect();
      }
    };
    window.addEventListener("hashchange", onPairingLink);
    return () => window.removeEventListener("hashchange", onPairingLink);
  }, [handleConnect, source, supported]);

  useEffect(() => {
    if (!supported || state.phase === "connected" || !origin) return;
    const onBrowserPaired = (event: StorageEvent) => {
      if (event.key === `trace.bridgeCredential:${origin}` && event.newValue) {
        void handleConnect();
      }
    };
    window.addEventListener("storage", onBrowserPaired);
    return () => window.removeEventListener("storage", onBrowserPaired);
  }, [handleConnect, origin, state.phase, supported]);

  if (state.phase === "connected") return children;

  const failure =
    !supported && state.phase === "idle"
      ? {
          kind: "incompatible" as const,
          eyebrow: "Unsupported browser",
          title: "This browser isn’t supported yet",
          description:
            "Use a current desktop version of Chrome or Firefox to connect to Trace on this device.",
        }
      : state.phase === "failed" && state.failure.kind !== "unpaired"
        ? state.failure
        : null;

  return (
    <main className="max-w-app mx-auto min-h-screen px-5 pb-16">
      <AppHeader bordered={false} showAccount={false} />
      <div className="pt-7 pb-header-y">
        <h2
          className={`${EYEBROW} inline-flex items-center gap-1.5 ${
            failure ? "text-warning" : "text-accent"
          }`}
        >
          {failure ? (
            <TriangleAlert size={12} aria-hidden="true" />
          ) : (
            <Cable size={12} aria-hidden="true" />
          )}
          {failure?.eyebrow ?? "Local connection"}
        </h2>
        <div aria-live="polite" aria-atomic="true">
          <h1 className="mt-3 mb-0 max-w-[34ch] text-page-title font-extrabold text-balance">
            {failure?.title ?? "Connect to Trace on this device"}
          </h1>
          <p className="mt-subtitle-top mb-0 max-w-row-description text-caption leading-relaxed text-text-muted">
            {failure?.description ??
              "Run the command below in Terminal, then return here. This page will connect automatically."}
          </p>
        </div>
      </div>

      {supported ? (
        <div className="flex flex-col items-start gap-3">
          {state.phase === "connecting" ? (
            <p
              role="status"
              className="m-0 inline-flex items-center gap-2 text-caption text-text-muted"
            >
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Connecting to Trace…
            </p>
          ) : failure ? (
            <>
              <button
                type="button"
                className={PRIMARY_ACTION}
                onClick={() => void handleConnect()}
              >
                <Cable size={14} aria-hidden="true" />
                Try again
              </button>
              {origin ? (
                <p
                  data-testid="connection-origin"
                  className="m-0 font-mono text-crumb text-text-muted"
                >
                  {origin}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <BrowserPairing source={source} onApproved={handleConnect} />
              <p className="m-0 max-w-row-description text-meta leading-relaxed text-text-muted">
                If your browser asks for local-network access, allow it to
                continue.
              </p>
              <details className="max-w-row-description text-meta text-text-muted">
                <summary className="cursor-pointer">
                  Need to set up Trace?
                </summary>
                <p>
                  On macOS, install Trace and run setup once. After setup,
                  return here to get your pairing command.
                </p>
                <pre className="overflow-x-auto rounded-control border border-border bg-surface p-3 text-crumb">
                  <code>{`npm install -g @arielbk/trace\n${setupCommand}`}</code>
                </pre>
              </details>
            </>
          )}
        </div>
      ) : null}

      {!failure ? <ConnectionScope /> : null}
    </main>
  );
}

/** The loopback address a local source is pointed at, for display only. */
function bridgeOrigin(source: { key: string }): string | undefined {
  return source.key.startsWith("local:")
    ? source.key.slice("local:".length)
    : undefined;
}

/**
 * What the connection is and is not, in the two-column shape the task page uses
 * for its context and next step. The right column exists because the hosted
 * board's allowlist is genuinely narrower than the local one, and a viewer who
 * learns that here does not go looking for an export button later.
 */
function ConnectionScope() {
  const { capabilities } = useTraceDataSource();

  return (
    <section
      data-testid="connection-scope"
      className="content-bleed mt-9 bg-surface py-6"
    >
      <div className="grid grid-cols-1 gap-y-7 md:grid-cols-2 md:gap-x-12">
        <div>
          <h3 className={`${EYEBROW} mb-3 tracking-wide text-text-muted`}>
            From this site
          </h3>
          <ul className="m-0 flex flex-col gap-2 p-0">
            <ScopeItem available>
              Browse tasks, timelines, and documents
            </ScopeItem>
            <ScopeItem available={capabilities.taskMutations}>
              Pin, unpin, archive, and restore tasks
            </ScopeItem>
          </ul>
        </div>
        <div>
          <h3 className={`${EYEBROW} mb-3 tracking-wide text-text-muted`}>
            Stays on this device
          </h3>
          <ul className="m-0 flex flex-col gap-2 p-0">
            <ScopeItem available={capabilities.docEdits}>
              Editing a document’s checkboxes
            </ScopeItem>
            <ScopeItem available={capabilities.taskExports}>
              Exporting tasks and transcripts
            </ScopeItem>
            <ScopeItem available={capabilities.account}>
              Account and Cloud Sync settings
            </ScopeItem>
          </ul>
        </div>
      </div>
    </section>
  );
}

/**
 * One capability line. An available one is checked in accent; a withheld one
 * keeps the same row but drops to a muted dot, so the two columns read as one
 * list of the same shape rather than a promise beside a warning.
 */
function ScopeItem({
  available = false,
  children,
}: {
  available?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      data-available={available}
      className="flex items-center gap-2 font-mono text-crumb text-text-muted"
    >
      {available ? (
        <Check size={13} className="shrink-0 text-accent" aria-hidden="true" />
      ) : (
        <span
          className="size-1.5 shrink-0 rounded-full bg-border-strong"
          aria-hidden="true"
        />
      )}
      <span>{children}</span>
    </li>
  );
}

/**
 * The hosted board's header control, standing where the local board's account
 * button stands and wearing the same circular shape. It shares the recovery
 * banner’s live state. The trigger carries no permanent indicator dot; the
 * connection details wait in the popover.
 */
export function LocalConnectionBadge() {
  const source = useTraceDataSource();
  const origin = bridgeOrigin(source);
  const { status, loss } = useConnectionHealth();
  const connected = status === "healthy";
  const statusLabel = connected
    ? "Connected locally"
    : status === "recovering"
      ? "Reconnecting…"
      : loss?.kind === "revoked"
        ? "Access revoked"
        : loss?.kind === "outdated"
          ? "Update needed"
          : "Not connected";

  return (
    <Dropdown>
      <DropdownTrigger
        className="relative inline-flex items-center justify-center size-8 rounded-full border border-border bg-surface text-text hover:text-accent hover:border-border-strong transition-colors cursor-pointer"
        aria-label={`Connection — ${connected ? "connected to Trace on this device" : statusLabel.toLowerCase()}`}
        data-connection-state={connected ? "connected" : status}
      >
        <Cable size={16} aria-hidden="true" />
      </DropdownTrigger>
      <DropdownContent
        aria-label="Connection"
        origin="top-right"
        align="end"
        sideOffset={8}
        className="w-64 text-caption text-text"
      >
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="inline-flex items-center justify-center size-7 shrink-0 rounded-full bg-chip-bg text-text-muted">
            <Cable size={15} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex flex-col">
            <span className="truncate font-semibold text-text">
              This device
            </span>
            {origin ? (
              <span className="truncate font-mono text-meta text-text-muted">
                {origin}
              </span>
            ) : null}
          </span>
        </div>
        {/* The state's own dot leads the line, the same shape the account
            popover uses for its sync block. */}
        <div className="flex flex-col gap-1 border-t border-border-subtle px-3 py-2.5">
          <span className="flex items-start gap-2">
            <span
              className={`mt-1.5 size-2 shrink-0 rounded-full ${connected ? "bg-accent" : "bg-warning"}`}
              aria-hidden="true"
            />
            <span className="min-w-0 text-text-muted">{statusLabel}</span>
          </span>
          {!connected ? (
            <span className="pl-4 text-meta leading-relaxed text-text-muted">
              The connection is interrupted. The board is showing previously
              loaded information.
            </span>
          ) : null}
        </div>
      </DropdownContent>
    </Dropdown>
  );
}
