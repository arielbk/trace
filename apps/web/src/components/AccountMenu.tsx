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
import { cn } from "../lib/utils.ts";
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
 * on-demand sync belongs to `trace sync`. Signing in and out are the
 * exceptions, because a terminal was previously the only way to do either.
 */
export function AccountMenu({ now }: { now?: Date }) {
  const { data } = useSyncStatus();
  const account = describeAccount(data, now);

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
    onSuccess: recordAttempt,
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
        onSubmitKey={(key) =>
          submitKey.mutate({ attemptId: attempt.attemptId, key })
        }
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

  return (
    <>
      {/* Sync block: the state's own dot leads the line, so the popover
          reads the same way the trigger badge does. */}
      <div className={cn(SECTION, "flex flex-col gap-1")}>
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

      {account.canSignIn ? (
        <div className={SECTION}>
          <button
            type="button"
            className={PRIMARY_ACTION}
            onClick={() => beginLogin.mutate("github")}
            disabled={beginLogin.isPending}
          >
            Sign in with GitHub
          </button>
          {beginLogin.isError ? (
            <p
              className="mt-1.5 mb-0 text-meta text-warning wrap-anywhere"
              data-testid="login-error"
            >
              {beginLogin.error.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {account.canSignOut ? (
        <div className={SECTION}>
          <button
            type="button"
            className={SECONDARY_ACTION}
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </>
  );
}

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
            once, and Trace cannot recover it for you.
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
 * The key step of a login into an account that already holds synced documents.
 *
 * The board never judges the key: it hands what the user typed to the serving
 * process, which proves it against the account's own wrapped keys. A refusal
 * comes back on the attempt and leaves the user right here, on the prompt, with
 * their next try one field away.
 *
 * Replacing the key instead is deliberately the harder path — the same warning
 * and the same typed phrase `trace login` demands — because a fresh key makes
 * every already-synced document unreadable, permanently. It stays a quiet text
 * action until it is chosen, so the loud control in this block is always the
 * one that keeps those documents readable.
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

const FIELD_CLASS =
  "w-full rounded-control border border-border bg-bg px-2 py-1.5 font-mono text-crumb text-text outline-none transition-colors focus:border-border-strong";

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
 * The language never claims the machine is "up to date": Trace cannot know
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
