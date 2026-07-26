import type { SyncStatusResponse } from "@trace/core/browser";
import { CircleUser, Loader2, TriangleAlert } from "lucide-react";
import { formatRelativeTime } from "../format.ts";
import { useSyncStatus } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/Dropdown.tsx";

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

        {/* Sync block: the state's own dot leads the line, so the popover
                reads the same way the trigger badge does. */}
        <div className="border-t border-border-subtle px-3 py-2.5 flex flex-col gap-1">
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
      </DropdownContent>
    </Dropdown>
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
  if (!status || !("state" in status)) {
    return { state: "unknown", triggerLabel: "Account", headline: "Loading…" };
  }

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
      "state" | "triggerLabel" | "name" | "email"
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
      return {
        state: "unknown",
        triggerLabel: "Account",
        headline: "Loading…",
      };
  }
}
