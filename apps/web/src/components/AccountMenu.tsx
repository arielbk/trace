import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  REPLACEMENT_KEY_CONFIRMATION,
  REPLACEMENT_KEY_WARNING,
  type KeyTransferInspection,
  type KeyTransferRequestView,
  type LoginAttemptView,
  type LoginProvider,
  type PendingKeyTransfer,
  type SyncStatusResponse,
} from "@trace/core/browser";
import { CircleUser, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatRelativeTime } from "../format.ts";
import {
  acknowledgeGeneratedKey,
  approveKeyTransfer,
  cancelKeyTransfer,
  cancelLogin,
  denyKeyTransfer,
  generateReplacementKey,
  openKeyTransfer,
  postLogout,
  requestKeyTransfer,
  startLogin,
  submitExistingKey,
  traceQueryKey,
  useCurrentLogin,
  useKeyTransfers,
  isForgottenLogin,
  useLoginAttempt,
  useSyncStatus,
} from "../lib/api.ts";
import { useTraceDataSource } from "../lib/trace-data-source.ts";
import { cn } from "../lib/utils.ts";
import { SuccessCheckIcon } from "./icons.tsx";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/Dropdown.tsx";

/**
 * The board's global account control: a user-circle button in the shared header
 * with a sync-state indicator, opening a popover that reports the machine's
 * Cloud Sync state and signs it in or out. It replaces the long status sentence
 * the task list used to carry, so the same information is one click away from
 * every board page.
 *
 * The state it reports comes from the local `GET /api/sync/status` endpoint —
 * the board never contacts the hosted sync service to render account state, and
 * a login is performed by the serving process rather than here.
 *
 * The menu stays read-only about synchronization: there is no AutoSync toggle
 * and no "Sync now", because AutoSync is a machine-local CLI setting and an
 * on-demand sync belongs to `eqnx sync`. Signing in and out are the
 * exceptions, because a terminal was previously the only way to do either.
 */
export function AccountMenu({ now }: { now?: Date }) {
  const { data, isError } = useSyncStatus();
  const account = isError ? unreachable() : describeAccount(data, now);

  return (
    <Dropdown>
      <DropdownTrigger
        className="relative inline-flex items-center justify-center size-8 rounded-full border border-border bg-surface text-text hover:text-accent hover:border-border-strong transition-colors cursor-pointer"
        aria-label={account.triggerLabel}
        data-sync-state={account.state}
      >
        <CircleUser size={16} aria-hidden="true" />
        <SyncIndicator state={account.state} />
      </DropdownTrigger>
      <DropdownContent
        aria-label="Account"
        origin="top-right"
        align="end"
        sideOffset={8}
        className="w-64 text-caption text-text"
      >
        {/* Identity block: the name leads, the address is supporting
            detail, and each gets its own line so neither wraps. */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="inline-flex items-center justify-center size-7 shrink-0 rounded-full bg-chip-bg text-text-muted">
            <CircleUser size={15} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex flex-col">
            <span className="truncate font-semibold text-text">
              {account.name ?? "Not signed in"}
            </span>
            {account.email ? (
              <span className="truncate font-mono text-meta text-text-muted">
                {account.email}
              </span>
            ) : null}
          </span>
        </div>

        <div className={SECTION}>
          <p className="m-0 font-semibold">Local connection</p>
          <p className="mt-1 mb-0 text-meta text-text-muted">
            This board shows work stored on this Mac. Your account syncs it with
            your other machines.
          </p>
        </div>
        <AccountBody account={account} />
      </DropdownContent>
    </Dropdown>
  );
}

/** Every block under the identity: the section rule plus its own padding. */
const SECTION = "border-t border-border-subtle px-3 py-2.5";

/**
 * The popover's controls, in the weights the rest of the board already uses: an
 * accent-soft primary for the step that carries a flow forward, the neutral
 * bordered control beside it, and plain text for quiet actions — cancelling,
 * dismissing, taking the destructive path. A block never offers three equally
 * loud buttons.
 */
const PRIMARY_ACTION =
  "w-full rounded-control border border-transparent bg-accent-soft px-2 py-1.5 text-caption font-semibold text-accent transition-colors cursor-pointer hover:border-accent disabled:cursor-default disabled:opacity-60";

const SECONDARY_ACTION =
  "w-full inline-flex items-center justify-center rounded-control border border-border bg-surface px-2 py-1.5 text-caption font-semibold text-text no-underline transition-colors cursor-pointer hover:text-accent hover:border-border-strong disabled:cursor-default disabled:opacity-60";

const QUIET_ACTION =
  "border-0 bg-transparent p-0 text-meta text-text-muted underline transition-colors cursor-pointer hover:text-accent disabled:cursor-default disabled:opacity-60";

/**
 * Everything below the identity, which is either a login in flight or the
 * machine's ordinary sync state and the one action available on it.
 *
 * A login is a machine-local device authorization the serving process performs
 * — the board only starts it, sends the user to the hosted approval page in a
 * new tab, and watches it. The one secret that reaches the browser is a freshly
 * generated document encryption key, held in component state (through the query
 * cache) for exactly as long as it takes the user to save it. It is never
 * written to storage, a URL, or a log.
 *
 * While an attempt is in flight the sync blocks step aside: "Sign in to sync
 * this machine's tasks" is not worth saying to someone already halfway through
 * signing in, and the popover stays short enough to take in at a glance.
 */
function AccountBody({ account }: { account: AccountDescription }) {
  const queryClient = useQueryClient();
  const source = useTraceDataSource();
  const [attemptId, setAttemptId] = useState<string | null>(null);
  // Whether this popover has settled on which attempt it watches. It is a
  // one-way latch: once the popover has adopted an attempt, or deliberately let
  // one go, the outstanding-login answer must not pull it back.
  const [claimed, setClaimed] = useState(false);
  const { data: outstanding, isPending: findingOutstanding } =
    useCurrentLogin();
  const { data: watched, error: watchError } = useLoginAttempt(attemptId);
  // A machine that no longer knows this attempt has forgotten it — `eqnx
  // serve` restarted, and attempts live in that process's memory. The login is
  // over whatever the last poll said, and a key prompt nothing is listening to
  // is worse than saying so.
  const attempt = interrupted(watched, watchError) ?? watched;
  const unlocked = useUnlockBeat();

  /** Take up an attempt, wherever it came from, and watch it from here. */
  const watchAttempt = useCallback(
    (view: LoginAttemptView) => {
      queryClient.setQueryData(
        traceQueryKey(source, "login-attempt", view.attemptId),
        view,
      );
      queryClient.setQueryData(traceQueryKey(source, "current-login"), view);
      setAttemptId(view.attemptId);
      setClaimed(true);
    },
    [queryClient, source],
  );

  /** Let go of an attempt that is over — nothing is outstanding after this. */
  const forgetAttempt = useCallback(() => {
    queryClient.setQueryData(traceQueryKey(source, "current-login"), null);
    setAttemptId(null);
    setClaimed(true);
  }, [queryClient, source]);

  // A popover opens knowing nothing, so it asks. Adopting the attempt at
  // whatever state it has reached is what makes closing the popover mid-login
  // survivable: the serving process, not this component, is where an attempt
  // lives.
  useEffect(() => {
    if (claimed || !outstanding) return;
    watchAttempt(outstanding);
  }, [claimed, outstanding, watchAttempt]);

  const beginLogin = useMutation({
    mutationFn: (provider: LoginProvider) => startLogin(provider, source),
    onSuccess: (started) => {
      // Opened from the user's click so the popup is not blocked, and with
      // `noopener` so the hosted page gets no handle on the board.
      window.open(started.verificationUrl, "_blank", "noopener,noreferrer");
      watchAttempt(started);
    },
  });
  const recordAttempt = (settled: LoginAttemptView) => {
    queryClient.setQueryData(
      traceQueryKey(source, "login-attempt", settled.attemptId),
      settled,
    );
  };
  const acknowledge = useMutation({
    mutationFn: (attemptId: string) =>
      acknowledgeGeneratedKey(attemptId, source),
    onSuccess: recordAttempt,
  });
  const submitKey = useMutation({
    mutationFn: ({ attemptId, key }: { attemptId: string; key: string }) =>
      submitExistingKey(attemptId, key, source),
    onSuccess: (settled) => {
      recordAttempt(settled);
      // Only this path unlocks anything: a key the service accepted is a key
      // that decrypted the account's documents. A refusal comes back on the
      // same attempt still waiting for a key, and says so where it was typed.
      if (settled.state === "complete") unlocked.flash();
    },
  });
  const replaceKey = useMutation({
    mutationFn: ({
      attemptId,
      confirmation,
    }: {
      attemptId: string;
      confirmation: string;
    }) => generateReplacementKey(attemptId, confirmation, source),
    onSuccess: recordAttempt,
  });
  const cancel = useMutation({
    mutationFn: (attemptId: string) => cancelLogin(attemptId, source),
    onSuccess: recordAttempt,
  });
  const askAnotherMachine = useMutation({
    mutationFn: (attemptId: string) => requestKeyTransfer(attemptId, source),
    onSuccess: recordAttempt,
  });
  const stopAsking = useMutation({
    mutationFn: (attemptId: string) => cancelKeyTransfer(attemptId, source),
    onSuccess: recordAttempt,
  });
  const signOut = useMutation({
    mutationFn: () => postLogout(source),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: traceQueryKey(source, "sync-status"),
      });
    },
  });

  // A completed login is no longer an attempt worth showing: drop it and let
  // the ordinary sync status describe the now signed-in machine.
  useEffect(() => {
    if (attempt?.state !== "complete") return;
    forgetAttempt();
    void queryClient.invalidateQueries({
      queryKey: traceQueryKey(source, "sync-status"),
    });
  }, [attempt?.state, forgetAttempt, queryClient, source]);

  if (attempt && attempt.state !== "complete") {
    return (
      <LoginProgress
        attempt={attempt}
        keyPending={submitKey.isPending || replaceKey.isPending}
        onAcknowledge={() => acknowledge.mutate(attempt.attemptId)}
        onSubmitKey={(key) =>
          submitKey.mutate({ attemptId: attempt.attemptId, key })
        }
        onReplaceKey={(confirmation) =>
          replaceKey.mutate({ attemptId: attempt.attemptId, confirmation })
        }
        onCancel={() => cancel.mutate(attempt.attemptId)}
        // A runtime that predates key transfer answers these routes with a
        // refusal, so the affordance is not offered against one.
        transferSupported={source.capabilities.keyTransfer}
        transferPending={askAnotherMachine.isPending}
        onRequestTransfer={() => askAnotherMachine.mutate(attempt.attemptId)}
        onCancelTransfer={() => stopAsking.mutate(attempt.attemptId)}
        onDismiss={forgetAttempt}
        onRetry={() => {
          forgetAttempt();
          beginLogin.mutate(attempt.provider);
        }}
      />
    );
  }

  return (
    <>
      {/* The unlock beat. It sits above the sync block rather than in place of
          it: the machine is already signed in by the time this renders, and
          hiding the state it just reached would turn a confirmation into
          another wait. */}
      {unlocked.showing ? (
        <div
          className={cn(SECTION, "flex items-center gap-2 text-accent")}
          data-testid="unlock-confirmation"
        >
          <SuccessCheckIcon shown />
          <span className="min-w-0 font-semibold">Documents unlocked</span>
        </div>
      ) : null}

      {/* Above the sync block: someone is standing at another machine waiting
          for an answer, which outranks how this one's own sync is doing. */}
      <ApprovalRequests
        enabled={account.state !== "logged-out" && source.capabilities.keyTransfer}
      />

      {/* Sync block: the state's own dot leads the line, so the popover
          reads the same way the trigger badge does. */}
      <div role="status" aria-live="polite" className={cn(SECTION, "flex flex-col gap-1")}>
        <span className="flex items-start gap-2">
          <StateDot state={account.state} />
          <span className="min-w-0 text-text-muted">{account.headline}</span>
        </span>
        {account.detail ? (
          <span
            className="pl-4 text-meta text-text-muted wrap-anywhere"
            data-testid="account-sync-detail"
          >
            {account.detail}
          </span>
        ) : null}
      </div>

      {account.autoSyncLabel ? (
        <dl className="m-0 border-t border-border-subtle px-3 py-2 flex items-baseline justify-between gap-3">
          <dt className="m-0 text-meta text-text-muted">AutoSync</dt>
          <dd
            className="m-0 font-mono text-meta text-text"
            data-testid="account-auto-sync"
          >
            {account.autoSyncLabel}
          </dd>
        </dl>
      ) : null}

      {/* Never offered before the outstanding-login answer is in: a machine
          stopped at the key prompt is signed out as far as sync status knows,
          and inviting a second device approval in that half-second is how the
          user ends up with two attempts and no key. */}
      {account.canSignIn && !findingOutstanding ? (
        <div className={cn(SECTION, "flex flex-col gap-1.5")}>
          {/* GitHub leads on the accent control and the rest follow on the
              neutral one — not because a provider is better, but because the
              block needs one obvious way in. It is also the provider the
              serving process falls back to when none is named. */}
          {SIGN_IN_PROVIDERS.map(({ provider, label }, index) => (
            <button
              key={provider}
              type="button"
              className={index === 0 ? PRIMARY_ACTION : SECONDARY_ACTION}
              onClick={() => beginLogin.mutate(provider)}
              disabled={beginLogin.isPending}
            >
              {label}
            </button>
          ))}
          {beginLogin.isError ? (
            <p
              className="m-0 text-meta text-warning wrap-anywhere"
              data-testid="login-error"
            >
              {beginLogin.error.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {account.canSignOut && !source.capabilities.accountSignOut ? (
        <div className={SECTION}>
          <p className="m-0 text-meta text-text-muted">
            To sign out on this Mac, run <code>eqnx logout</code> in Terminal.
            Your local work stays available. Run <code>eqnx update</code> to
            enable sign-out here.
          </p>
        </div>
      ) : null}

      {account.canSignOut && source.capabilities.accountSignOut ? (
        <div className={SECTION}>
          <button
            type="button"
            className={SECONDARY_ACTION}
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            Sign out
          </button>
          <p className="mt-1.5 mb-0 text-meta text-text-muted">
            Stops sync on this Mac. Your local work stays available.
          </p>
          {/* A refused sign-out has to say so. Nothing else on the popover
              changes when it fails — the machine stays signed in and the button
              stays where it was — so without this line the click reads as a
              dead control. */}
          {signOut.isError ? (
            <p
              className="mt-1.5 mb-0 text-meta text-warning wrap-anywhere"
              role="alert"
              data-testid="logout-error"
            >
              {signOut.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * How long the unlock confirmation stays up. The same beat the archive button
 * flashes, for the same reason: long enough to register, short enough that it
 * never reads as a state the user is waiting out.
 */
const UNLOCK_BEAT_MS = 1100;

/**
 * A one-shot confirmation that the documents unlocked, which clears itself.
 *
 * It is deliberately not derived from the attempt's state. A completed attempt
 * is dropped the moment it completes — that is what lets the popover settle
 * into the signed-in state — so there is nothing left to render from, and the
 * beat has to be its own short-lived fact.
 *
 * Reduced motion is handled where the rest of the board handles it: the check's
 * `.t-success-check` animation is silenced by the stylesheet, leaving the
 * confirmation legible and still.
 */
function useUnlockBeat(): { showing: boolean; flash: () => void } {
  const [showing, setShowing] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const flash = useCallback(() => {
    setShowing(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setShowing(false);
    }, UNLOCK_BEAT_MS);
  }, []);

  return { showing, flash };
}

/**
 * The providers a board sign-in may go through. Both take the identical
 * machine-local device workflow — the provider is only a hint the serving
 * process forwards to the hosted approval page, which carries it through social
 * sign-in. Nothing about a provider changes what the board does with the
 * result, which is why this is a list and not two code paths.
 */
const SIGN_IN_PROVIDERS: { provider: LoginProvider; label: string }[] = [
  { provider: "github", label: "Sign in with GitHub" },
  { provider: "google", label: "Sign in with Google" },
];

/** The stages of a login in flight, rendered inside the account popover. */
function LoginProgress({
  attempt,
  keyPending,
  onAcknowledge,
  onSubmitKey,
  onReplaceKey,
  onCancel,
  transferSupported,
  transferPending,
  onRequestTransfer,
  onCancelTransfer,
  onDismiss,
  onRetry,
}: {
  attempt: LoginAttemptView;
  keyPending: boolean;
  onAcknowledge: () => void;
  onSubmitKey: (key: string) => void;
  onReplaceKey: (confirmation: string) => void;
  onCancel: () => void;
  transferSupported: boolean;
  transferPending: boolean;
  onRequestTransfer: () => void;
  onCancelTransfer: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className={cn(SECTION, "flex flex-col gap-2")}
      data-testid="login-progress"
      data-login-state={attempt.state}
    >
      {attempt.state === "waiting-for-approval" ? (
        <>
          {/* Led by the same spinner the syncing state uses, so a wait looks
              like a wait wherever the popover shows one. */}
          <span className="flex items-start gap-2">
            <Loader2
              size={10}
              className="t-sync-spinner animate-spin mt-1 shrink-0 text-text-muted"
              aria-hidden="true"
            />
            <span className="min-w-0 text-text-muted">
              Waiting for approval in your browser…
            </span>
          </span>
          <span className="block rounded-sm bg-chip-bg px-2 py-1 text-center font-mono text-crumb tracking-widest text-text">
            {attempt.userCode}
          </span>
          <a
            href={attempt.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={SECONDARY_ACTION}
          >
            Reopen the approval page
          </a>
          {/* Closing the popover must not abandon a device approval the user is
              still completing in the other tab — cancelling is deliberate. */}
          <button type="button" className={QUIET_ACTION} onClick={onCancel}>
            Cancel sign-in
          </button>
        </>
      ) : null}

      {attempt.state === "showing-generated-key" ? (
        <>
          <p className="m-0 text-text-muted">
            Save this document encryption key somewhere safe. It is shown only
            once, and EQNX cannot recover it for you.
          </p>
          <code
            className="block rounded-sm bg-chip-bg px-2 py-1.5 font-mono text-meta break-all text-text"
            data-testid="generated-key"
          >
            {attempt.generatedKey}
          </code>
          <button
            type="button"
            className={PRIMARY_ACTION}
            onClick={onAcknowledge}
          >
            I have saved it
          </button>
        </>
      ) : null}

      {attempt.state === "waiting-for-existing-key" ? (
        <ExistingKeyStep
          error={attempt.error}
          pending={keyPending}
          transfer={attempt.transfer}
          transferSupported={transferSupported}
          transferPending={transferPending}
          onRequestTransfer={onRequestTransfer}
          onCancelTransfer={onCancelTransfer}
          onSubmitKey={onSubmitKey}
          onReplaceKey={onReplaceKey}
          onCancel={onCancel}
        />
      ) : null}

      {SETTLED_LOGIN_STATES.includes(attempt.state) ? (
        <>
          <span className="flex items-start gap-2">
            <TriangleAlert
              size={10}
              className="mt-1 shrink-0 text-warning"
              aria-hidden="true"
            />
            <span
              className="min-w-0 text-text-muted wrap-anywhere"
              data-testid="login-outcome"
            >
              {attempt.error ?? SETTLED_LOGIN_MESSAGES[attempt.state]}
            </span>
          </span>
          <button type="button" className={PRIMARY_ACTION} onClick={onRetry}>
            Try again
          </button>
          <button type="button" className={QUIET_ACTION} onClick={onDismiss}>
            Dismiss
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The other end of the same journey, on a machine that is already signed in:
 * this account's machines asking to be let in.
 *
 * The name a request gives itself is a label, not evidence — the code is the
 * evidence, and it exists only once both machines have committed to their keys.
 * So the request is opened first and approved second, and the approval control
 * says what the user is asserting rather than merely "Approve".
 *
 * Nothing here is destructive to this machine; what it risks is the account's
 * documents on someone else's. That is why the loud control is the one that
 * refuses, and the accent control appears only beside a code to check.
 */
function ApprovalRequests({ enabled }: { enabled: boolean }) {
  const source = useTraceDataSource();
  const queryClient = useQueryClient();
  const { data: pending, error: listError } = useKeyTransfers(enabled);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<KeyTransferInspection | null>(
    null,
  );

  const forget = () => {
    setInspection(null);
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: traceQueryKey(source, "key-transfers") });
  };
  const reportError = (error: Error) => {
    setInspection(null);
    setActionError(error.message);
    void queryClient.invalidateQueries({ queryKey: traceQueryKey(source, "key-transfers") });
  };
  const open = useMutation({
    mutationFn: (requestId: string) => openKeyTransfer(requestId, source),
    onMutate: () => setActionError(null),
    onSuccess: (next) => {
      setInspection(next);
      if (next.state === "gone") setActionError("That request is no longer available. Ask the other machine to start a new one.");
    },
    onError: reportError,
  });
  const approve = useMutation({
    mutationFn: (requestId: string) => approveKeyTransfer(requestId, source),
    onSuccess: forget,
    onMutate: () => setActionError(null),
    onError: reportError,
  });
  const deny = useMutation({
    mutationFn: (requestId: string) => denyKeyTransfer(requestId, source),
    onSuccess: forget,
    onMutate: () => setActionError(null),
    onError: reportError,
  });

  // The other machine reveals its key a moment after this one offers, so an
  // opened request that has nothing to compare yet asks again — once a second,
  // and only while it is on screen.
  const openMutate = open.mutate;
  useEffect(() => {
    if (inspection?.state !== "waiting-for-reveal") return;
    const timer = setTimeout(() => {
      openMutate(inspection.requestId);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [inspection?.state, inspection?.requestId, openMutate, inspection]);

  if (!enabled) return null;
  if (inspection && inspection.state !== "gone") {
    return (
      <div
        className={cn(SECTION, "flex flex-col gap-2")}
        data-testid="approval-request"
        data-approval-state={inspection.state}
      >
        <span className="min-w-0 text-text-muted">
          <span className="font-semibold text-text">
            {inspection.machineName}
          </span>{" "}
          is asking for this account&rsquo;s documents.
        </span>
        {inspection.state === "comparing" ? (
          <>
            <p className="m-0 text-meta text-text-muted">
              Approve only if this code is showing on that machine right now.
            </p>
            <code
              className="block rounded-sm bg-chip-bg px-2 py-1.5 text-center font-mono text-text tracking-widest"
              data-testid="approval-code"
            >
              {inspection.verificationCode}
            </code>
            <button
              type="button"
              className={PRIMARY_ACTION}
              disabled={approve.isPending}
              onClick={() => approve.mutate(inspection.requestId)}
            >
              The codes match — approve
            </button>
          </>
        ) : (
          <span className="flex items-start gap-2">
            <Loader2
              size={10}
              className="mt-1 shrink-0 animate-spin text-text-muted"
              aria-hidden="true"
            />
            <span className="min-w-0 text-meta text-text-muted">
              Waiting for that machine to show its code&hellip;
            </span>
          </span>
        )}
        <span className="flex items-center gap-2">
          <button
            type="button"
            className={QUIET_ACTION}
            disabled={deny.isPending}
            onClick={() => deny.mutate(inspection.requestId)}
          >
            Deny
          </button>
          <span className="text-meta text-text-muted" aria-hidden="true">
            ·
          </span>
          <button type="button" className={QUIET_ACTION} onClick={forget}>
            Not now
          </button>
        </span>
      </div>
    );
  }

  const waiting: PendingKeyTransfer[] = pending ?? [];
  const error = actionError ?? listError?.message;
  if (waiting.length === 0 && !error) return null;

  return (
    <div className={cn(SECTION, "flex flex-col gap-2")}>
      {error ? <p role="alert" className="m-0 text-meta text-danger">{error}</p> : null}
      {waiting.map((request) => (
        <div key={request.requestId} className="flex flex-col gap-1.5">
          <span className="min-w-0 text-text-muted">
            <span className="font-semibold text-text">
              {request.machineName}
            </span>{" "}
            is asking to be unlocked.
          </span>
          <span className="font-mono text-meta text-text-muted">
            {request.locator}
          </span>
          <button
            type="button"
            className={SECONDARY_ACTION}
            disabled={open.isPending}
            onClick={() => open.mutate(request.requestId)}
          >
            Review request
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The key step of a login into an account that already holds synced documents.
 *
 * The board never judges the key: it hands what the user typed to the serving
 * process, which proves it against the account's own wrapped keys. A refusal
 * comes back on the attempt and leaves the user right here, on the prompt, with
 * their next try one field away.
 *
 * Replacing the key instead is deliberately the harder path — the same warning
 * and the same typed phrase `eqnx login` demands — because a fresh key makes
 * every already-synced document unreadable, permanently. It stays a quiet text
 * action until it is chosen, so the loud control in this block is always the
 * one that keeps those documents readable.
 */
function ExistingKeyStep({
  error,
  pending,
  transfer,
  transferSupported,
  transferPending,
  onRequestTransfer,
  onCancelTransfer,
  onSubmitKey,
  onReplaceKey,
  onCancel,
}: {
  error?: string;
  pending: boolean;
  transfer?: KeyTransferRequestView;
  transferSupported: boolean;
  transferPending: boolean;
  onRequestTransfer: () => void;
  onCancelTransfer: () => void;
  onSubmitKey: (key: string) => void;
  onReplaceKey: (confirmation: string) => void;
  onCancel: () => void;
}) {
  const keyFieldId = useId();
  const confirmFieldId = useId();
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  const live =
    transfer &&
    (transfer.state === "waiting-for-approval" || transfer.state === "comparing");

  return (
    <>
      <p className="m-0 text-text-muted">
        This account already has synced documents. Unlock this machine from one
        that already has them, or enter the document encryption key you saved
        when you first signed in.
      </p>

      {transferSupported && !live ? (
        <>
          <button
            type="button"
            className={SECONDARY_ACTION}
            disabled={transferPending}
            onClick={onRequestTransfer}
          >
            Approve from another machine
          </button>
          {/* A request that ended says so here rather than replacing the step:
              the key field below is still a way through. */}
          {transfer?.error ? (
            <p
              className="m-0 text-meta text-warning wrap-anywhere"
              data-testid="transfer-outcome"
            >
              {transfer.error}
            </p>
          ) : null}
        </>
      ) : null}

      {live ? <TransferRequest transfer={transfer} onCancel={onCancelTransfer} /> : null}
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmitKey(key.trim());
        }}
      >
        <label className="text-meta text-text-muted" htmlFor={keyFieldId}>
          Document encryption key
        </label>
        <input
          id={keyFieldId}
          className={FIELD_CLASS}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {/* The refusal sits with the field it refused, above the button that
            sends the next attempt. */}
        {error ? (
          <p
            className="m-0 text-meta text-warning wrap-anywhere"
            data-testid="existing-key-error"
          >
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className={PRIMARY_ACTION}
          disabled={pending || key.trim() === ""}
        >
          Continue
        </button>
      </form>

      {replacing ? (
        <form
          className="flex flex-col gap-1.5 border-t border-border-subtle pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            onReplaceKey(confirmation.trim());
          }}
        >
          <span className="flex items-start gap-2">
            <TriangleAlert
              size={10}
              className="mt-1 shrink-0 text-warning"
              aria-hidden="true"
            />
            <span className="min-w-0 text-meta text-warning">
              {REPLACEMENT_KEY_WARNING}
            </span>
          </span>
          <label className="text-meta text-text-muted" htmlFor={confirmFieldId}>
            Type {REPLACEMENT_KEY_CONFIRMATION} to confirm
          </label>
          <input
            id={confirmFieldId}
            className={FIELD_CLASS}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {/* Never the accent control: generating a replacement is the path
              that loses documents, so it does not get the inviting one. */}
          <button
            type="submit"
            className={SECONDARY_ACTION}
            disabled={
              pending || confirmation.trim() !== REPLACEMENT_KEY_CONFIRMATION
            }
          >
            Generate new key
          </button>
        </form>
      ) : null}

      <span className="flex items-center gap-2">
        {replacing ? null : (
          <>
            <button
              type="button"
              className={QUIET_ACTION}
              onClick={() => setReplacing(true)}
            >
              Use a new key instead
            </button>
            <span className="text-meta text-text-muted" aria-hidden="true">
              ·
            </span>
          </>
        )}
        <button type="button" className={QUIET_ACTION} onClick={onCancel}>
          Cancel sign-in
        </button>
      </span>
    </>
  );
}

/**
 * The request this machine has out with another of the account's machines.
 *
 * Two values are on screen and they mean different things, so they are never
 * shown alike: the locator is how the user finds the right row over there, and
 * the code is the only thing that says the two machines are talking to each
 * other rather than to something in between. The instruction to compare is
 * stated where the code is, because a code nobody compares buys nothing.
 */
function TransferRequest({
  transfer,
  onCancel,
}: {
  transfer: KeyTransferRequestView;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-control border border-border-subtle px-2 py-2"
      data-testid="transfer-request"
      data-transfer-state={transfer.state}
    >
      {transfer.state === "comparing" ? (
        <>
          <p className="m-0 text-meta text-text-muted">
            Check this code matches the one on your other machine, then approve
            it there.
          </p>
          <code
            className="block rounded-sm bg-chip-bg px-2 py-1.5 text-center font-mono text-text tracking-widest"
            data-testid="transfer-code"
          >
            {transfer.verificationCode}
          </code>
        </>
      ) : (
        <>
          <span className="flex items-start gap-2">
            <Loader2
              size={10}
              className="mt-1 shrink-0 animate-spin text-text-muted"
              aria-hidden="true"
            />
            <span className="min-w-0 text-meta text-text-muted">
              Open EQNX on a machine that already has your documents and find
              this request:
            </span>
          </span>
          <code
            className="block rounded-sm bg-chip-bg px-2 py-1.5 text-center font-mono text-text tracking-widest"
            data-testid="transfer-locator"
          >
            {transfer.locator}
          </code>
        </>
      )}
      <button type="button" className={QUIET_ACTION} onClick={onCancel}>
        Stop waiting
      </button>
    </div>
  );
}

const FIELD_CLASS =
  "w-full rounded-control border border-border bg-bg px-2 py-1.5 font-mono text-crumb text-text outline-none transition-colors focus:border-border-strong";

/** Attempt states that are over, and the wording each gets when the service
 * offered no message of its own. */
export const LOGIN_INTERRUPTED_MESSAGE =
  "This machine no longer has that sign-in — it was interrupted. Start again to sign in.";

/**
 * The attempt as it now stands, when the machine has answered that it has none.
 *
 * A one-time generated key is the exception: it was shown from this board's own
 * memory and is the only copy the user may ever see, so an interruption must
 * not sweep it off the screen before they have saved it.
 */
function interrupted(
  view: LoginAttemptView | undefined,
  error: unknown,
): LoginAttemptView | undefined {
  if (!view || !isForgottenLogin(error)) return undefined;
  if (view.state === "showing-generated-key") return undefined;
  const interruptedView: LoginAttemptView = {
    ...view,
    state: "failed",
    error: LOGIN_INTERRUPTED_MESSAGE,
  };
  // Neither survives the process that held them, so neither belongs on screen.
  delete interruptedView.generatedKey;
  delete interruptedView.transfer;
  return interruptedView;
}

const SETTLED_LOGIN_MESSAGES: Partial<
  Record<LoginAttemptView["state"], string>
> = {
  failed: "Sign-in failed.",
  expired: "The sign-in request expired.",
  cancelled: "Sign-in cancelled.",
};

const SETTLED_LOGIN_STATES = Object.keys(
  SETTLED_LOGIN_MESSAGES,
) as LoginAttemptView["state"][];

/**
 * The dot overlaid on the account icon, for the states that carry information:
 * a run in flight, a failure, a machine that has never synced. An up-to-date
 * machine is the resting case and carries nothing, so the badge means something
 * whenever it is lit.
 *
 * It is decorative — the trigger's accessible name already carries the same
 * state in words — so it is hidden from assistive technology. The spinner is
 * silenced under
 * `prefers-reduced-motion` by the stylesheet's `.t-sync-spinner` rule, the same
 * way the board's other animations opt out; the state stays legible from the
 * indicator's colour and from the popover.
 */
function SyncIndicator({ state }: { state: AccountState }) {
  // A signed-out machine has no sync to report, so it carries no badge at all.
  if (state === "logged-out" || state === "unknown") return null;

  // Nor does a machine that is simply up to date: success is the resting state,
  // and a badge that is almost always lit says nothing when it matters. Only
  // the states that carry information — a run in flight, a failure, a machine
  // that has never synced — mark the avatar.
  if (state === "synced") return null;

  const base =
    "absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-surface";

  if (state === "syncing") {
    return (
      <span className={base} data-sync-indicator="syncing" aria-hidden="true">
        <Loader2
          size={10}
          className="t-sync-spinner animate-spin text-accent"
        />
      </span>
    );
  }

  if (state === "failed") {
    return (
      <span
        className={`${base} text-warning`}
        data-sync-indicator="failed"
        aria-hidden="true"
      >
        <TriangleAlert size={10} />
      </span>
    );
  }

  // What is left is a machine that is signed in but has never synced.
  return (
    <span
      className={`${base} size-2 bg-border-strong`}
      data-sync-indicator="idle"
      aria-hidden="true"
    />
  );
}

/**
 * The same state, restated inside the popover so the headline is anchored to a
 * colour rather than floating as a bare sentence. Decorative for the same
 * reason the trigger badge is: the wording beside it already says it.
 */
function StateDot({ state }: { state: AccountState }) {
  if (state === "syncing") {
    return (
      <Loader2
        size={10}
        className="t-sync-spinner animate-spin mt-1 shrink-0 text-text-muted"
        aria-hidden="true"
      />
    );
  }

  if (state === "failed") {
    return (
      <TriangleAlert
        size={10}
        className="mt-1 shrink-0 text-warning"
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      className={cn(
        "mt-1.5 size-2 shrink-0 rounded-full",
        state === "synced" ? "bg-accent" : "bg-border-strong",
      )}
      aria-hidden="true"
    />
  );
}

/** The account states the menu renders, plus `unknown` before the first read. */
type AccountState = SyncStatusResponse["state"] | "unknown";

export interface AccountDescription {
  state: AccountState;
  /** Accessible name of the trigger: account plus its sync state in words. */
  triggerLabel: string;
  /** Display name, or the address when that is all the identity we have. */
  name?: string;
  /** The address, only when it is not already serving as the name. */
  email?: string;
  /** The popover's primary sync line. */
  headline: string;
  /** Secondary line: a failure message, or the retained last-success time. */
  detail?: string;
  /** Rendered AutoSync mode, or undefined when there is no mode worth showing. */
  autoSyncLabel?: string;
  /** Signed out with a sync server to sign in to. */
  canSignIn: boolean;
  /** Signed in, so this machine's token can be removed. */
  canSignOut: boolean;
}

/**
 * Split the recorded identity into its display parts. Login stores whatever it
 * could resolve — `name <email>`, a bare name, a bare address, or an id — so a
 * missing angle-bracket pair is normal, not malformed: the whole string then
 * leads on its own and there is no second line.
 */
function splitIdentity(identity: string | undefined): {
  name?: string;
  email?: string;
} {
  if (!identity) return {};
  const match = /^(.*?)\s*<([^>]+)>$/.exec(identity.trim());
  if (!match) return { name: identity };
  const [, name, email] = match;
  return name ? { name, email } : { name: email };
}

/**
 * Map a sync-status payload to everything the menu renders. Exported for direct
 * unit testing, and to keep the wording of each state in one place.
 *
 * The language never claims the machine is "up to date": EQNX cannot know
 * whether another machine has changes it has not published yet, so the menu
 * reports when it last synced and nothing stronger.
 */
export function describeAccount(
  status: SyncStatusResponse | undefined,
  now?: Date,
): AccountDescription {
  if (!status || !("state" in status)) return loading();

  const identity = splitIdentity(
    "identity" in status ? status.identity : undefined,
  );
  const autoSyncLabel =
    status.state === "logged-out" || status.autoSync === undefined
      ? undefined
      : status.autoSync
        ? "On"
        : "Off — manual sync only";
  const lastSynced =
    "lastSyncedAt" in status && status.lastSyncedAt
      ? `Last synced ${formatRelativeTime(status.lastSyncedAt, now)}`
      : undefined;

  const described = (
    fields: Omit<
      AccountDescription,
      "state" | "triggerLabel" | "name" | "email" | "canSignIn" | "canSignOut"
    > & {
      summary: string;
    },
  ): AccountDescription => {
    const { summary, ...rest } = fields;
    return {
      state: status.state,
      triggerLabel: `Account — ${summary}`,
      ...identity,
      autoSyncLabel,
      canSignIn:
        status.state === "logged-out" && Boolean(status.serverConfigured),
      canSignOut: status.state !== "logged-out",
      ...rest,
    };
  };

  const restore = status.state === "logged-out" ? undefined : status.restore;
  // Work that has not landed on this machine yet. Once it has, the field stays
  // behind as the settled description of the machine, and the runs that follow
  // are ordinary syncing rather than a restore still arriving.
  const arriving = restore?.phase === "ready" ? undefined : restore;
  const paused = status.state !== "logged-out" && status.autoSync === false;
  // What to tell someone whose recovery stalled. With automatic sync off there
  // is no retry coming, so promising one would be a lie.
  const retry = paused
    ? "Automatic sync is off on this machine; run eqnx sync on this machine to retry."
    : "Automatic sync will retry; run eqnx sync on this machine to retry now.";

  // A restore in flight — or one that died in flight — describes this machine
  // better than the policy that governs its *next* run, so those two states
  // are reported before sync policy is.
  if (arriving) {
    if (status.state === "failed")
      return described({
        summary: "restore interrupted",
        headline:
          arriving.phase === "documents"
            ? "Tasks arrived; document recovery was interrupted."
            : "Could not bring work onto this machine.",
        detail: `${status.lastError} · Check this machine’s connection. ${retry}`,
      });
    if (status.state === "syncing")
      return described({
        summary: "bringing work onto this machine",
        headline:
          arriving.phase === "documents"
            ? "Bringing documents onto this machine…"
            : "Bringing tasks onto this machine…",
        detail: "Signed in. Work is served by EQNX on this machine.",
      });
    // Partial recovery outranks the paused line: the tasks are usable but the
    // documents are not here, and that is the thing to act on.
    if (arriving.phase === "partial")
      return described({
        summary: "documents pending",
        headline: "Some documents are still waiting.",
        detail: `Your available tasks remain usable. ${retry}`,
      });
  }

  // Policy comes last among the settled states, and stands in front of
  // "ready": a machine that will not sync again on its own has not finished
  // recovering in any lasting sense, so it is never described as ready.
  if (paused)
    return described({
      summary: "sync paused",
      headline: "Sync is paused on this machine.",
      detail:
        "Run eqnx config set auto-sync true on this machine to resume automatic sync.",
    });

  // Signed in, nothing started yet: the unlock landed but no run has reported
  // anything, so the honest thing is to say the work is still to come.
  if (arriving)
    return described({
      summary: "waiting for sync",
      headline: "Signed in. Waiting to bring work onto this machine.",
      detail: "Run eqnx sync on this machine if recovery does not start.",
    });

  if (restore && status.state === "synced")
    return described({
      summary: "work ready on this machine",
      headline:
        restore.taskCount === 0
          ? "Ready — no synced tasks in this account yet."
          : "Work is ready on this machine.",
      detail: lastSynced,
    });

  switch (status.state) {
    case "logged-out":
      return status.serverConfigured
        ? described({
            summary: "not signed in",
            headline: "Sign in to sync this machine's tasks.",
          })
        : described({
            summary: "Cloud Sync not configured",
            headline: "Cloud Sync is not configured on this machine.",
            // The state a freshly installed second machine lands in. Naming
            // the command is the whole difference between a dead end and a
            // next step, and it is the same one `eqnx login` prints.
            detail: "Run eqnx config set server-url <url> on this machine.",
          });
    case "never-synced":
      return described({
        summary: "not synced yet",
        headline: "Not synced yet.",
      });
    case "syncing":
      return described({
        summary: "syncing",
        headline: "Syncing…",
        // A run in flight does not invalidate the last success, so it stays
        // visible underneath.
        detail: lastSynced,
      });
    case "synced":
      return described({
        summary: `last synced ${formatRelativeTime(status.lastSyncedAt, now)}`,
        headline: lastSynced ?? "Last synced.",
      });
    case "failed":
      return described({
        summary: "sync failed",
        headline: "Last sync failed.",
        // The failure message first, but a prior success is still worth
        // knowing: it says how stale the local state actually is.
        detail: [status.lastError, lastSynced].filter(Boolean).join(" · "),
      });
    default:
      return loading();
  }
}

/**
 * The status read itself failed: the serving process is unreachable, or
 * refusing this browser. Nothing about the account can be claimed, and neither
 * signing in nor out would reach the machine that holds the credential, so
 * both are withheld rather than offered and failed. The task view the board
 * already fetched is untouched — this is one query going quiet, not a board
 * that has lost its connection, which `ConnectionRecovery` reports separately.
 */
function unreachable(): AccountDescription {
  return {
    state: "unknown",
    triggerLabel: "Account — sync status unavailable",
    headline: "Cannot reach this machine’s sync status.",
    detail:
      "Check that EQNX is running on this machine, then reconnect. Your existing task view is still available.",
    canSignIn: false,
    canSignOut: false,
  };
}

/** Before the first status read there is nothing to say and nothing to act on. */
function loading(): AccountDescription {
  return {
    state: "unknown",
    triggerLabel: "Account",
    headline: "Loading…",
    canSignIn: false,
    canSignOut: false,
  };
}
