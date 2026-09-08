import { Cable, Loader2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { TraceConnection } from "@trace/core/browser";
import {
  useConnectionRecovery,
  type ConnectionLoss,
} from "../lib/connection-recovery.ts";
import { useTraceDataSource } from "../lib/trace-data-source.ts";

/** What the viewer is told, and what they can do about it. */
type LossNotice = {
  title: string;
  description: string;
  /** Absent when asking again cannot help. */
  action?: "reconnect";
};

/**
 * Copy for a connection that was working and then stopped. It is deliberately
 * three messages, not one: a refusal and a version change are settled facts
 * with different remedies, while everything else is grouped under a single
 * honest description rather than guessing which of stopped, blocked, or
 * offline the browser actually saw.
 */
function describeLoss(loss: ConnectionLoss): LossNotice {
  switch (loss.kind) {
    case "revoked":
      return {
        title: "This browser’s access was revoked",
        description:
          "Trace is running on this device but no longer accepts this browser. Run `trace board` on that device to open it through a new pairing link.",
      };
    case "outdated":
      return {
        title: "Trace on this device changed version",
        description:
          "The Trace running here now speaks a connection protocol this site does not. Reload this page to pick up the change.",
      };
    case "unreachable":
      return {
        title: "Trace isn’t responding",
        description:
          "The connection to Trace on this device stopped answering. Check that Trace is still running, and allow local-network access if your browser asks for it.",
        action: "reconnect",
      };
  }
}

const BANNER_ACTION =
  "inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-control border border-transparent bg-accent-soft px-3 text-meta font-semibold text-accent transition-colors cursor-pointer hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * Watches the connection the board is already reading, and reports it when it
 * goes away. The board stays mounted underneath: a connection that drops for
 * ten seconds should not throw away the page the viewer was reading, so this
 * says what happened above the content rather than replacing it with the
 * connect gate again.
 */
export function ConnectionRecovery({
  children,
  probe,
}: {
  children: ReactNode;
  /** Injectable handshake, so tests never reach the network. */
  probe?: () => Promise<TraceConnection>;
}) {
  const source = useTraceDataSource();
  const { status, loss, retry } = useConnectionRecovery({
    probe: probe ?? (() => source.connect()),
  });

  return (
    <>
      {status === "healthy" || !loss ? null : (
        <div
          role="status"
          aria-live="polite"
          className="sticky top-0 z-40 flex items-start gap-2.5 border-b border-border bg-surface px-5 py-2.5 text-caption text-text"
        >
          {status === "recovering" ? (
            <>
              <Loader2
                size={14}
                className="mt-0.5 shrink-0 animate-spin text-text-muted"
                aria-hidden="true"
              />
              <span className="min-w-0 text-text-muted">
                Reconnecting to Trace on this device…
              </span>
            </>
          ) : (
            <LostNotice notice={describeLoss(loss)} onReconnect={retry} />
          )}
        </div>
      )}
      {children}
    </>
  );
}

function LostNotice({
  notice,
  onReconnect,
}: {
  notice: LossNotice;
  onReconnect: () => void;
}) {
  return (
    <>
      <TriangleAlert
        size={14}
        className="mt-0.5 shrink-0 text-warning"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{notice.title}</span>
        <span className="ml-1.5 text-text-muted">{notice.description}</span>
      </span>
      {notice.action === "reconnect" ? (
        <button type="button" className={BANNER_ACTION} onClick={onReconnect}>
          <Cable size={13} aria-hidden="true" />
          Reconnect
        </button>
      ) : null}
    </>
  );
}
