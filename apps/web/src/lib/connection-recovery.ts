import { TRACE_PROTOCOL_VERSION, type TraceConnection } from "@trace/core/browser";
import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { HttpError } from "./trace-data-source.ts";

/**
 * How often the board re-handshakes with the connection it is reading. The
 * board holds no socket to the runtime, so a connection that goes away after
 * the first handshake is only observable by asking again.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The bounded backoff behind a connection that stopped answering. It is short
 * and finite on purpose: a laptop that slept, a service restarting under
 * `trace update`, or a board left open overnight should all recover on their
 * own, and anything longer-lived should say so rather than retry forever.
 */
export const RECONNECT_DELAYS_MS = [1_000, 4_000, 15_000] as const;

/**
 * Why the board can no longer read this machine. Two of these are settled
 * facts the viewer has to act on; the third is deliberately broad, because a
 * refused fetch cannot tell a stopped service from a denied local-network
 * permission from an unplugged network, and guessing between them would put
 * confident wrong advice in front of the viewer.
 */
export type ConnectionLoss =
  /** Trace answered and refused: the credential was revoked, or this origin is
   * no longer the one it allows. */
  | { kind: "revoked"; status: number }
  /** Trace answered a handshake this board does not speak — it was upgraded
   * (or downgraded) underneath an open tab. */
  | { kind: "outdated"; protocolVersion: number }
  /** Ambiguous: stopped, asleep, blocked, or offline. */
  | { kind: "unreachable" };

export type ConnectionRecoveryState = {
  status: "healthy" | "recovering" | "lost";
  /** What went wrong, while it is going wrong. Null whenever healthy. */
  loss: ConnectionLoss | null;
  /** Retries spent on the current loss, for a UI that wants to say so. */
  attempt: number;
  /** Probe now, at the viewer's request. */
  retry: () => void;
};

export const ConnectionHealthContext = createContext<
  Pick<ConnectionRecoveryState, "status" | "loss">
>({ status: "healthy", loss: null });

export function useConnectionHealth() {
  return useContext(ConnectionHealthContext);
}

/**
 * Classify a failed handshake. Only an answer from Trace itself is treated as
 * a settled refusal; everything else stays in the one honest bucket.
 */
export function classifyConnectionLoss(error: unknown): ConnectionLoss {
  return error instanceof HttpError &&
    (error.status === 401 || error.status === 403)
    ? { kind: "revoked", status: error.status }
    : { kind: "unreachable" };
}

/** Whether waiting and asking again could plausibly fix this. */
function isTransient(loss: ConnectionLoss): boolean {
  return loss.kind === "unreachable";
}

/**
 * Watch a connection that has already handshaked once, and recover it when it
 * comes back. It probes on a heartbeat and whenever the viewer returns to the
 * tab, retries an ambiguous failure a bounded number of times, and stops at a
 * refusal or a protocol change — neither of which another request would fix.
 *
 * Everything it starts is torn down on unmount, and an answer that arrives
 * after unmount is dropped rather than applied to a gone component.
 */
export function useConnectionRecovery({
  probe,
  enabled = true,
}: {
  probe: () => Promise<TraceConnection>;
  enabled?: boolean;
}): ConnectionRecoveryState {
  const [state, setState] = useState<{
    status: ConnectionRecoveryState["status"];
    loss: ConnectionLoss | null;
    attempt: number;
  }>({ status: "healthy", loss: null, attempt: 0 });

  // The probe is called from timers and listeners that outlive any one render,
  // so it is read through a ref rather than captured in their closures.
  const probeRef = useRef(probe);
  probeRef.current = probe;

  const live = useRef(false);
  // The heartbeat stops once the loss is settled — retrying is bounded, and a
  // revoked credential or a protocol change is not fixed by asking again. The
  // viewer returning to the tab, or asking explicitly, starts it over.
  const settled = useRef(false);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(async (attemptsSpent: number): Promise<void> => {
    if (!live.current || pending.current) return;
    pending.current = true;

    let loss: ConnectionLoss | null = null;
    try {
      const connection = await probeRef.current();
      if (connection?.protocolVersion !== TRACE_PROTOCOL_VERSION) {
        loss = {
          kind: "outdated",
          protocolVersion: Number(connection?.protocolVersion),
        };
      }
    } catch (error) {
      loss = classifyConnectionLoss(error);
    } finally {
      pending.current = false;
    }

    // The component may have gone while the request was in flight; a resolved
    // probe must not revive its state.
    if (!live.current) return;

    if (!loss) {
      settled.current = false;
      setState({ status: "healthy", loss: null, attempt: 0 });
      return;
    }

    const spent = attemptsSpent + 1;
    const retryable = isTransient(loss) && spent <= RECONNECT_DELAYS_MS.length;
    settled.current = !retryable;
    setState({
      status: retryable ? "recovering" : "lost",
      loss,
      attempt: attemptsSpent,
    });
    if (retryable) {
      const delay = RECONNECT_DELAYS_MS[spent - 1] as number;
      timer.current = setTimeout(() => void check(spent), delay);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    live.current = true;

    // A tab the viewer just came back to is the moment a stale board is most
    // visible, so it re-checks then regardless of where the heartbeat is.
    const onFocus = () => void check(0);
    window.addEventListener("focus", onFocus);
    const heartbeat = setInterval(() => {
      if (!settled.current) void check(0);
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      live.current = false;
      window.removeEventListener("focus", onFocus);
      clearInterval(heartbeat);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [check, enabled]);

  const retry = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    void check(0);
  }, [check]);

  return { ...state, retry };
}
