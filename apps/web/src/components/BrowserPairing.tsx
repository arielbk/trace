import { useEffect, useState } from "react";
import { HttpError, type TraceDataSource } from "../lib/trace-data-source.ts";
import { CopyPromptButton } from "./CopyPromptButton.tsx";

type State =
  | { phase: "preparing" }
  | { phase: "waiting"; code: string }
  | { phase: "stopped"; message: string; unavailable: boolean };

/** The command contains only a request identifier. The claim secret stays in this tab. */
export function BrowserPairing({
  source,
  onApproved,
  setupCommand = "eqnx setup",
}: {
  source: TraceDataSource;
  onApproved: () => Promise<void>;
  setupCommand?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ phase: "preparing" });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestSignal = () =>
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    async function start() {
      setState({ phase: "preparing" });
      try {
        if (!source.beginPairing || !source.pollPairing)
          throw new Error("Pairing unavailable");
        const request = await source.beginPairing(requestSignal());
        if (controller.signal.aborted) return;
        setState({ phase: "waiting", code: request.code });
        async function poll() {
          try {
            if (Date.now() >= request.expiresAt)
              throw new HttpError(410, "Expired");
            const approved = await source.pollPairing!(
              request.secret,
              requestSignal(),
            );
            if (controller.signal.aborted) return;
            if (approved) {
              await onApproved();
              return;
            }
            timer = setTimeout(() => void poll(), 1_000);
          } catch (error) {
            stop(error);
          }
        }
        timer = setTimeout(() => void poll(), 1_000);
      } catch (error) {
        stop(error);
      }
    }
    function stop(error: unknown) {
      if (controller.signal.aborted) return;
      setState({
        phase: "stopped",
        unavailable: !(error instanceof HttpError),
        message:
          error instanceof HttpError && error.status === 410
            ? "This command has expired. Get a new command to continue."
            : error instanceof HttpError && error.status === 429
              ? "There are several pairing requests waiting. Wait a few minutes, then get a new command."
              : "EQNX isn’t reachable on this device. Install it if needed, then run setup.",
      });
    }
    void start();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [source, onApproved, attempt]);

  if (state.phase === "preparing")
    return (
      <p role="status" className="m-0 text-caption text-text-muted">
        Checking EQNX on this device…
      </p>
    );
  if (state.phase === "stopped")
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="status" className="m-0 text-caption text-text-muted">
          {state.message}
        </p>
        {state.unavailable ? <SetupInstructions command={setupCommand} /> : null}
        <button
          type="button"
          className="rounded-control bg-accent-soft px-4 py-2 text-caption font-semibold text-accent cursor-pointer"
          onClick={() => setAttempt((value) => value + 1)}
        >
          {state.unavailable ? "Check connection" : "Get pairing command"}
        </button>
      </div>
    );
  const command = `eqnx pair ${state.code}`;
  return (
    <>
      <div className="flex max-w-full flex-wrap items-center gap-4 rounded-control border border-border bg-surface px-4 py-3">
        <code className="min-w-0 break-all font-mono text-caption text-text">
          {command}
        </code>
        <CopyPromptButton
          label="Copy command"
          copyLabel="Copy command"
          value={command}
        />
      </div>
      <p role="status" className="m-0 text-meta text-text-muted">
        Waiting for approval in Terminal…
      </p>
    </>
  );
}


export function SetupInstructions({ command }: { command: string }) {
  const install = `npm install -g @eqnx/cli\n${command}`;
  return (
    <div className="flex max-w-full flex-col gap-3 text-meta text-text-muted">
      <p className="m-0">First time on this Mac? Install EQNX and run setup in Terminal:</p>
      <div className="flex max-w-full flex-wrap items-center gap-4 rounded-control border border-border bg-surface px-4 py-3">
        <pre className="m-0 overflow-x-auto text-crumb"><code>{install}</code></pre>
        <CopyPromptButton label="Copy setup commands" copyLabel="Copy setup commands" value={install} />
      </div>
      <p className="m-0">Already installed? Run <code>{command}</code> to start the local connection, then check again.</p>
    </div>
  );
}
