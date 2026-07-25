import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { SyncStatusResponse } from "@trace/core/browser";
import { CircleUser, Loader2, TriangleAlert } from "lucide-react";
import { formatRelativeTime } from "../format.ts";
import { useSyncStatus } from "../lib/api.ts";

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
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

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
  if (!status || !("state" in status)) {
    return { state: "unknown", triggerLabel: "Account", headline: "Loading…" };
  }

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
    fields: Omit<AccountDescription, "state" | "triggerLabel"> & {
      summary: string;
    },
  ): AccountDescription => {
    const { summary, ...rest } = fields;
    return {
      state: status.state,
      triggerLabel: `Account — ${summary}`,
      identity,
      autoSyncLabel,
      ...rest,
    };
  };

  switch (status.state) {
    case "logged-out":
      return status.serverConfigured
        ? described({
            summary: "not signed in",
            headline: "Run trace login to connect this machine.",
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
      return { state: "unknown", triggerLabel: "Account", headline: "Loading…" };
  }
}
