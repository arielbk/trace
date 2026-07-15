import type { SyncStatus } from "@trace/core/browser";
import { formatRelativeTime } from "../format.ts";
import { useSyncStatus } from "../lib/api.ts";

/**
 * Header badge for the local board: the logged-in GitHub identity and the
 * last-sync state ("synced 2m ago" / "sync failed" / "not logged in"). Backed by
 * the local `GET /api/sync/status` endpoint — login itself stays in the CLI, so
 * the logged-out copy points the user at `trace login`.
 *
 * Renders nothing until the first status resolves (and stays silent on an
 * error/malformed payload) so it never flashes a wrong state on the board.
 * A logged-out machine with no sync server configured (`serverConfigured`
 * false) renders nothing at all: cloud sync is invisible until a server URL
 * exists to log in to.
 */
export function SyncStatusBadge({ now }: { now?: Date }) {
  const { data } = useSyncStatus();
  const label = describeSyncStatus(data, now);
  if (!label) return null;

  return (
    <span
      className="font-mono text-crumb text-text-muted whitespace-nowrap"
      data-sync-state={data?.state}
      title={label.title}
    >
      {label.text}
    </span>
  );
}

/**
 * Map a resolved {@link SyncStatus} to the header's display text (and an
 * optional hover title), or `null` when there is nothing trustworthy to show.
 * Exported for direct unit testing without a DOM.
 */
export function describeSyncStatus(
  status: SyncStatus | undefined,
  now?: Date,
): { text: string; title?: string } | null {
  if (!status) return null;
  // Identity is best-effort (only recorded at `trace login`), so it prefixes
  // the state text rather than gating it.
  const prefix = "identity" in status && status.identity ? `${status.identity} · ` : "";
  switch (status.state) {
    case "logged-out":
      // No server configured means nothing to log in to — hide the badge
      // rather than advertise a login that cannot succeed.
      if (!status.serverConfigured) return null;
      return { text: "not logged in — run `trace login`" };
    case "never-synced":
      return { text: `${prefix}not synced yet` };
    case "synced":
      return {
        text: `${prefix}synced ${formatRelativeTime(status.lastSyncedAt, now)}`,
      };
    case "failed":
      return {
        text: `${prefix}sync failed`,
        title: status.lastError,
      };
    default:
      return null;
  }
}
