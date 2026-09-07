import { AlertTriangle, Cable, Loader2, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  TRACE_PROTOCOL_VERSION,
  type TraceConnection,
} from "@trace/core/browser";
import { fetchTraceConnection, HttpError } from "../lib/api.ts";
import { AppHeader } from "./AppHeader.tsx";

type ConnectionState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "connected" }
  | { phase: "failed"; failure: ConnectionFailure };

export type ConnectionFailure = {
  kind: "unavailable" | "blocked" | "incompatible";
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
      title: "This Trace connection isn’t compatible",
      description:
        "The service on this device did not return a valid Trace handshake. Update Trace, then try again.",
    };
  }

  if (connection.protocolVersion !== TRACE_PROTOCOL_VERSION) {
    return {
      kind: "incompatible",
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
  if (error instanceof HttpError && error.status === 403) {
    return {
      kind: "blocked",
      title: "Trace blocked this site",
      description:
        "This hosted address is not allowed to read Trace on this device. Update or restart Trace, then try again.",
    };
  }

  return {
    kind: "unavailable",
    title: "Trace isn’t reachable",
    description:
      "Make sure Trace is running on this device. If your browser asks for local-network access, allow it, then try again.",
  };
}

export function LocalTraceConnection({
  children,
  connect = fetchTraceConnection,
  userAgent = navigator.userAgent,
}: {
  children: ReactNode;
  connect?: () => Promise<TraceConnection>;
  userAgent?: string;
}) {
  const supported = supportsLocalTraceBridge(userAgent);
  const [state, setState] = useState<ConnectionState>({ phase: "idle" });

  if (state.phase === "connected") return children;

  async function handleConnect() {
    setState({ phase: "connecting" });
    try {
      const connection = await connect();
      const failure = validateTraceConnection(connection);
      setState(failure ? { phase: "failed", failure } : { phase: "connected" });
    } catch (error) {
      setState({ phase: "failed", failure: connectionFailure(error) });
    }
  }

  const failure =
    !supported && state.phase === "idle"
      ? {
          kind: "incompatible" as const,
          title: "This browser isn’t supported yet",
          description:
            "Use a current desktop version of Chrome or Firefox to connect to Trace on this device.",
        }
      : state.phase === "failed"
        ? state.failure
        : null;

  return (
    <main className="max-w-app mx-auto min-h-screen px-5 pb-16">
      <AppHeader bordered={false} showAccount={false} />
      <section className="mx-auto flex max-w-xl flex-col items-start pt-20 sm:pt-28">
        <span className="mb-5 inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface text-accent shadow-sm">
          {failure ? (
            <AlertTriangle size={21} aria-hidden="true" />
          ) : (
            <Cable size={21} aria-hidden="true" />
          )}
        </span>
        <h1 className="m-0 text-page-title font-extrabold text-balance">
          {failure?.title ?? "Connect to Trace on this device"}
        </h1>
        <div aria-live="polite" aria-atomic="true">
          <p className="mt-3 mb-0 max-w-[58ch] text-caption leading-relaxed text-text-muted">
            {failure?.description ??
              "Trace keeps your tasks and files on this device. Connect to let this site read your local task list."}
          </p>
        </div>

        {!failure ? (
          <div className="mt-6 flex gap-3 rounded-lg border border-border bg-surface p-4 text-caption leading-relaxed text-text-muted">
            <ShieldCheck
              size={18}
              className="mt-0.5 shrink-0 text-accent"
              aria-hidden="true"
            />
            <p className="m-0">
              Your browser may ask for permission to reach your local network.
              Allow it to continue. This preview is read-only: it can list task
              summaries, but it cannot change them or open local files.
            </p>
          </div>
        ) : null}

        {supported ? (
          <button
            type="button"
            className="mt-7 inline-flex min-h-10 items-center justify-center gap-2 rounded-control border border-accent bg-accent px-4 py-2 text-sm font-semibold text-tag-text cursor-pointer hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-wait disabled:opacity-60"
            disabled={state.phase === "connecting"}
            onClick={() => void handleConnect()}
          >
            {state.phase === "connecting" ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Cable size={16} aria-hidden="true" />
            )}
            {state.phase === "connecting"
              ? "Connecting…"
              : failure
                ? "Try again"
                : "Connect to Trace"}
          </button>
        ) : null}
      </section>
    </main>
  );
}

export function LocalConnectionBadge() {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap font-mono text-crumb text-text-muted">
      <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
      <span>This device · Connected locally</span>
      <span className="rounded border border-border px-1.5 py-px text-badge font-bold uppercase text-text-muted">
        Read-only
      </span>
    </span>
  );
}
