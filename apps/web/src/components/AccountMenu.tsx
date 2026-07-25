import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  REPLACEMENT_KEY_CONFIRMATION,
  REPLACEMENT_KEY_WARNING,
  type LoginAttemptView,
  type SyncStatusResponse,
} from "@trace/core/browser";
import { CircleUser, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { formatRelativeTime } from "../format.ts";
import {
  acknowledgeGeneratedKey,
  cancelLogin,
  generateReplacementKey,
  postLogout,
  startLogin,
  submitExistingKey,
  useLoginAttempt,
  useSyncStatus,
} from "../lib/api.ts";

/**
 * The board's global account control: a user-circle button in the shared header
 * with a sync-state indicator, opening a popover that reports the machine's
 * Cloud Sync state. It replaces the long status sentence the task list used to
 * carry, so the same information is one click away from every board page.
 *
 * Everything it shows comes from the local `GET /api/sync/status` endpoint —
 * the board never contacts the hosted sync service to render account state.
 * The menu is deliberately read-only about synchronization: there is no
 * AutoSync toggle and no "Sync now", because AutoSync is a machine-local CLI
 * setting and an on-demand sync belongs to `trace sync`.
 */
export function AccountMenu({ now }: { now?: Date }) {
  const { data } = useSyncStatus();
  const account = describeAccount(data, now);

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        className="relative inline-flex items-center justify-center size-8 rounded-full border border-border bg-surface text-text hover:text-accent hover:border-border-strong transition-colors cursor-pointer"
        aria-label={account.triggerLabel}
        data-sync-state={account.state}
      >
        <CircleUser size={16} aria-hidden="true" />
        <SyncIndicator state={account.state} />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label="Account"
          align="end"
          sideOffset={8}
          className="z-50 w-72 rounded-md border border-border bg-surface p-3 text-caption text-text shadow-lg"
        >
          <p className="m-0 font-mono text-crumb font-bold break-words">
            {account.identity ?? "Not signed in"}
          </p>
          <p className="mt-1.5 mb-0 text-text-muted">{account.headline}</p>
          {account.detail ? (
            <p
              className="mt-1.5 mb-0 font-mono text-crumb text-text-muted break-words"
              data-testid="account-sync-detail"
            >
              {account.detail}
            </p>
          ) : null}
          {account.autoSyncLabel ? (
            <dl className="mt-3 mb-0 flex items-baseline justify-between gap-3 border-t border-border-subtle pt-2">
              <dt className="m-0 text-text-muted">AutoSync</dt>
              <dd
                className="m-0 font-mono text-crumb"
                data-testid="account-auto-sync"
              >
                {account.autoSyncLabel}
              </dd>
            </dl>
          ) : null}
          <AccountActions account={account} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * The account actions: signing this machine in, and signing it out.
 *
 * A login is a machine-local device authorization the serving process performs
 * — the board only starts it, sends the user to the hosted approval page in a
 * new tab, and watches it. The one secret that reaches the browser is a freshly
 * generated document encryption key, held in component state (through the query
 * cache) for exactly as long as it takes the user to save it. It is never
 * written to storage, a URL, or a log.
 */
function AccountActions({ account }: { account: AccountDescription }) {
  const queryClient = useQueryClient();
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const { data: attempt } = useLoginAttempt(attemptId);

  const beginLogin = useMutation({
    mutationFn: startLogin,
    onSuccess: (started) => {
      // Opened from the user's click so the popup is not blocked, and with
      // `noopener` so the hosted page gets no handle on the board.
      window.open(started.verificationUrl, "_blank", "noopener,noreferrer");
      queryClient.setQueryData(["login-attempt", started.attemptId], started);
      setAttemptId(started.attemptId);
    },
  });
  const recordAttempt = (settled: LoginAttemptView) => {
    queryClient.setQueryData(["login-attempt", settled.attemptId], settled);
  };
  const acknowledge = useMutation({
    mutationFn: acknowledgeGeneratedKey,
    onSuccess: recordAttempt,
  });
  const submitKey = useMutation({
    mutationFn: ({ attemptId, key }: { attemptId: string; key: string }) =>
      submitExistingKey(attemptId, key),
    onSuccess: recordAttempt,
  });
  const replaceKey = useMutation({
    mutationFn: ({
      attemptId,
      confirmation,
    }: {
      attemptId: string;
      confirmation: string;
    }) => generateReplacementKey(attemptId, confirmation),
    onSuccess: recordAttempt,
  });
  const cancel = useMutation({
    mutationFn: cancelLogin,
    onSuccess: (settled) => {
      queryClient.setQueryData(["login-attempt", settled.attemptId], settled);
    },
  });
  const signOut = useMutation({
    mutationFn: postLogout,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sync-status"] });
    },
  });

  // A completed login is no longer an attempt worth showing: drop it and let
  // the ordinary sync status describe the now signed-in machine.
  useEffect(() => {
    if (attempt?.state !== "complete") return;
    setAttemptId(null);
    void queryClient.invalidateQueries({ queryKey: ["sync-status"] });
  }, [attempt?.state, queryClient]);

  if (attempt && attempt.state !== "complete") {
    return (
      <LoginProgress
        attempt={attempt}
        keyPending={submitKey.isPending || replaceKey.isPending}
        onAcknowledge={() => acknowledge.mutate(attempt.attemptId)}
        onSubmitKey={(key) => submitKey.mutate({ attemptId: attempt.attemptId, key })}
        onReplaceKey={(confirmation) =>
          replaceKey.mutate({ attemptId: attempt.attemptId, confirmation })
        }
        onCancel={() => cancel.mutate(attempt.attemptId)}
        onDismiss={() => setAttemptId(null)}
        onRetry={() => {
          setAttemptId(null);
          beginLogin.mutate(attempt.provider);
        }}
      />
    );
  }

  if (account.canSignIn) {
    return (
      <div className="mt-3 border-t border-border-subtle pt-2">
        <button
          type="button"
          className={ACTION_CLASS}
          onClick={() => beginLogin.mutate("github")}
          disabled={beginLogin.isPending}
        >
          Sign in with GitHub
        </button>
        {beginLogin.isError ? (
          <p className="mt-1.5 mb-0 text-warning" data-testid="login-error">
            {beginLogin.error.message}
          </p>
        ) : null}
      </div>
    );
  }

  if (account.canSignOut) {
    return (
      <div className="mt-3 border-t border-border-subtle pt-2">
        <button
          type="button"
          className={ACTION_CLASS}
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
        >
          Sign out
        </button>
      </div>
    );
  }

  return null;
}

const ACTION_CLASS =
  "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-caption text-text hover:text-accent hover:border-border-strong transition-colors cursor-pointer disabled:cursor-default disabled:opacity-60";

/** The stages of a login in flight, rendered inside the account popover. */
function LoginProgress({
  attempt,
  keyPending,
  onAcknowledge,
  onSubmitKey,
  onReplaceKey,
  onCancel,
  onDismiss,
  onRetry,
}: {
  attempt: LoginAttemptView;
  keyPending: boolean;
  onAcknowledge: () => void;
  onSubmitKey: (key: string) => void;
  onReplaceKey: (confirmation: string) => void;
  onCancel: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="mt-3 border-t border-border-subtle pt-2"
      data-testid="login-progress"
      data-login-state={attempt.state}
    >
      {attempt.state === "waiting-for-approval" ? (
        <>
          <p className="m-0 text-text-muted">
            Waiting for approval in your browser…
          </p>
          <p className="mt-1.5 mb-0 font-mono text-crumb">{attempt.userCode}</p>
          <p className="mt-1.5 mb-0 text-text-muted">
            <a
              href={attempt.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Reopen the approval page
            </a>
          </p>
          {/* Closing the popover must not abandon a device approval the user is
              still completing in the other tab — cancelling is deliberate. */}
          <button type="button" className={`${ACTION_CLASS} mt-2`} onClick={onCancel}>
            Cancel sign-in
          </button>
        </>
      ) : null}

      {attempt.state === "showing-generated-key" ? (
        <>
          <p className="m-0 text-text-muted">
            Save this document encryption key somewhere safe. It is shown only
            once, and Trace cannot recover it for you.
          </p>
          <p
            className="mt-1.5 mb-0 font-mono text-crumb break-all"
            data-testid="generated-key"
          >
            {attempt.generatedKey}
          </p>
          <button
            type="button"
            className={`${ACTION_CLASS} mt-2`}
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
          onSubmitKey={onSubmitKey}
          onReplaceKey={onReplaceKey}
          onCancel={onCancel}
        />
      ) : null}

      {SETTLED_LOGIN_STATES.includes(attempt.state) ? (
        <>
          <p className="m-0 text-warning" data-testid="login-outcome">
            {attempt.error ?? SETTLED_LOGIN_MESSAGES[attempt.state]}
          </p>
          <button type="button" className={`${ACTION_CLASS} mt-2`} onClick={onRetry}>
            Try again
          </button>
          <button
            type="button"
            className={`${ACTION_CLASS} mt-1.5`}
            onClick={onDismiss}
          >
            Dismiss
          </button>
        </>
      ) : null}
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
 * and the same typed phrase `trace login` demands — because a fresh key makes
 * every already-synced document unreadable, permanently.
 */
function ExistingKeyStep({
  error,
  pending,
  onSubmitKey,
  onReplaceKey,
  onCancel,
}: {
  error?: string;
  pending: boolean;
  onSubmitKey: (key: string) => void;
  onReplaceKey: (confirmation: string) => void;
  onCancel: () => void;
}) {
  const keyFieldId = useId();
  const confirmFieldId = useId();
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  return (
    <>
      <p className="m-0 text-text-muted">
        This account already has synced documents. Enter the document encryption
        key you saved when you first signed in.
      </p>
      <form
        className="mt-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmitKey(key.trim());
        }}
      >
        <label className="block text-text-muted" htmlFor={keyFieldId}>
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
        <button
          type="submit"
          className={`${ACTION_CLASS} mt-2`}
          disabled={pending || key.trim() === ""}
        >
          Continue
        </button>
      </form>
      {error ? (
        <p className="mt-1.5 mb-0 text-warning" data-testid="existing-key-error">
          {error}
        </p>
      ) : null}

      {replacing ? (
        <form
          className="mt-3 border-t border-border-subtle pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            onReplaceKey(confirmation.trim());
          }}
        >
          <p className="m-0 text-warning">{REPLACEMENT_KEY_WARNING}</p>
          <label className="mt-1.5 block text-text-muted" htmlFor={confirmFieldId}>
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
          <button
            type="submit"
            className={`${ACTION_CLASS} mt-2`}
            disabled={pending || confirmation.trim() !== REPLACEMENT_KEY_CONFIRMATION}
          >
            Generate new key
          </button>
        </form>
      ) : (
        <button
          type="button"
          className={`${ACTION_CLASS} mt-2`}
          onClick={() => setReplacing(true)}
        >
          Use a new key instead
        </button>
      )}

      <button type="button" className={`${ACTION_CLASS} mt-1.5`} onClick={onCancel}>
        Cancel sign-in
      </button>
    </>
  );
}

const FIELD_CLASS =
  "mt-1 w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-crumb text-text";

/** Attempt states that are over, and the wording each gets when the service
 * offered no message of its own. */
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
 * The dot overlaid on the account icon. It is decorative — the trigger's
 * accessible name already carries the same state in words — so it is hidden
 * from assistive technology. The spinner is silenced under
 * `prefers-reduced-motion` by the stylesheet's `.t-sync-spinner` rule, the same
 * way the board's other animations opt out; the state stays legible from the
 * indicator's colour and from the popover.
 */
function SyncIndicator({ state }: { state: AccountState }) {
  // A signed-out machine has no sync to report, so it carries no badge at all.
  if (state === "logged-out" || state === "unknown") return null;

  const base =
    "absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-surface";

  if (state === "syncing") {
    return (
      <span className={base} data-sync-indicator="syncing" aria-hidden="true">
        <Loader2 size={10} className="t-sync-spinner animate-spin" />
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

  return (
    <span
      className={`${base} size-2 ${state === "synced" ? "bg-accent" : "bg-border-strong"}`}
      data-sync-indicator={state === "synced" ? "synced" : "idle"}
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
  identity?: string;
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
 * Map a sync-status payload to everything the menu renders. Exported for direct
 * unit testing, and to keep the wording of each state in one place.
 *
 * The language never claims the machine is "up to date": Trace cannot know
 * whether another machine has changes it has not published yet, so the menu
 * reports when it last synced and nothing stronger.
 */
export function describeAccount(
  status: SyncStatusResponse | undefined,
  now?: Date,
): AccountDescription {
  if (!status || !("state" in status)) return loading();

  const identity = "identity" in status ? status.identity : undefined;
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
    fields: Pick<AccountDescription, "headline"> &
      Partial<Pick<AccountDescription, "detail">> & { summary: string },
  ): AccountDescription => {
    const { summary, ...rest } = fields;
    return {
      state: status.state,
      triggerLabel: `Account — ${summary}`,
      identity,
      autoSyncLabel,
      canSignIn: status.state === "logged-out" && Boolean(status.serverConfigured),
      canSignOut: status.state !== "logged-out",
      ...rest,
    };
  };

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
