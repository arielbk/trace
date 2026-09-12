import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  KeyTransferInspection,
  LoginAttemptView,
  LoginProvider,
  PendingKeyTransfer,
  SyncStatusResponse,
  TaskSummary,
  TaskTimeline,
  TraceConnection,
} from "@trace/core/browser";
import {
  defaultTraceDataSource,
  HttpError,
  useTraceDataSource,
  type TraceDataSource,
} from "./trace-data-source.ts";

export { HttpError } from "./trace-data-source.ts";

export function traceQueryKey(
  source: TraceDataSource,
  ...parts: readonly unknown[]
): readonly unknown[] {
  return source.key === "same-origin" ? parts : [source.key, ...parts];
}

export async function fetchTasks(
  source: TraceDataSource = defaultTraceDataSource,
): Promise<TaskSummary[]> {
  const res = await source.request("/api/tasks");
  if (!res.ok)
    throw new HttpError(res.status, `GET /api/tasks failed: ${res.status}`);
  return res.json() as Promise<TaskSummary[]>;
}

export async function fetchTaskTimeline(
  id: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<TaskTimeline> {
  const res = await source.request(`/api/tasks/${id}/timeline`);
  if (!res.ok)
    throw new HttpError(
      res.status,
      `GET /api/tasks/${id}/timeline failed: ${res.status}`,
    );
  return res.json() as Promise<TaskTimeline>;
}

export type DocContents = {
  contentType: string;
  body: string;
};

export async function fetchDocContents(
  ref: string,
  docPath: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<DocContents> {
  const res = await source.request(
    `/api/tasks/${encodeURIComponent(ref)}/docs?path=${encodeURIComponent(docPath)}`,
  );
  const contentType = res.headers.get("content-type") ?? "text/plain";
  const body = await res.text();
  if (!res.ok) {
    throw new HttpError(
      res.status,
      body || `GET docs for ${docPath} failed: ${res.status}`,
    );
  }
  return { contentType, body };
}

export async function fetchSyncStatus(
  source: TraceDataSource = defaultTraceDataSource,
): Promise<SyncStatusResponse> {
  const res = await source.request("/api/sync/status");
  if (!res.ok)
    throw new HttpError(
      res.status,
      `GET /api/sync/status failed: ${res.status}`,
    );
  return res.json() as Promise<SyncStatusResponse>;
}

/** Ask the serving process to run a background sync now (fire-and-forget).
 * The server throttles repeat requests, so callers can fire freely; failures
 * (a dev server with no sync trigger, a network hiccup) never surface. */
export function requestServerSync(
  source: TraceDataSource = defaultTraceDataSource,
): void {
  void source.request("/api/sync", { method: "POST" }).catch(() => {});
}

export function fetchTraceConnection(
  source: TraceDataSource = defaultTraceDataSource,
): Promise<TraceConnection> {
  return source.connect();
}

/**
 * Request a server-side sync on mount and whenever the board window regains
 * focus. The polling queries only read the local database; this asks the
 * server to converge that database with other machines first, so acting on a
 * just-focused board (pin, archive) starts from fresh rows instead of stale
 * ones — shrinking the cross-machine last-write-wins clobber window.
 */
export function useServerSyncOnFocus(enabled = true): void {
  const source = useTraceDataSource();
  useEffect(() => {
    if (!enabled) return;
    const requestSync = () => requestServerSync(source);
    requestSync();
    window.addEventListener("focus", requestSync);
    return () => window.removeEventListener("focus", requestSync);
  }, [enabled, source]);
}

/**
 * The machine-local authentication endpoints. The board only ever starts,
 * watches, and settles a login attempt — the serving process holds the bearer
 * token, and no response here carries it.
 */
async function localAuth<T>(
  path: string,
  init?: RequestInit,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<T> {
  const res = await source.request(`/api/local-auth${path}`, init);
  if (!res.ok) {
    const detail = await res.text();
    throw new HttpError(
      res.status,
      detail || `local-auth ${path} failed: ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

export function startLogin(
  provider: LoginProvider,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    "/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    },
    source,
  );
}

export function fetchLoginAttempt(
  attemptId: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}`,
    undefined,
    source,
  );
}

/**
 * The login this machine is still in the middle of, or `null` when there is
 * none. A board tab's handle on an attempt lasts only as long as the popover
 * holding it, so this is what a freshly opened popover asks to find a login
 * someone walked away from — an approved attempt stopped at the key prompt
 * above all, which the serving process cannot finish on its own.
 */
export function fetchCurrentLogin(
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView | null> {
  return localAuth<LoginAttemptView | null>(
    "/login/current",
    undefined,
    source,
  );
}

export function acknowledgeGeneratedKey(
  attemptId: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/acknowledge-key`,
    { method: "POST" },
    source,
  );
}

/**
 * Offer the account's existing document encryption key. The key is sent to the
 * serving process, which validates it against the account's wrapped keys — the
 * board never decides whether a key is right, and a rejected key comes back as
 * an ordinary attempt view carrying the reason.
 */
export function submitExistingKey(
  attemptId: string,
  key: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/existing-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    },
    source,
  );
}

/** Abandon the account's existing documents in favour of a fresh key. */
export function generateReplacementKey(
  attemptId: string,
  confirmation: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/replacement-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    },
    source,
  );
}

export function cancelLogin(
  attemptId: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/cancel`,
    { method: "POST" },
    source,
  );
}

/**
 * Ask another of this account's machines to unlock this one, instead of typing
 * the recovery key. What comes back is the same attempt view, now carrying the
 * request's locator and — once both machines have committed to their keys — the
 * code the user must see matching on both screens.
 */
export function requestKeyTransfer(
  attemptId: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/transfer`,
    { method: "POST" },
    source,
  );
}

export function cancelKeyTransfer(
  attemptId: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/transfer/cancel`,
    { method: "POST" },
    source,
  );
}

/** The requests waiting for this machine — the already-signed-in one — to let
 * another machine in. */
export function fetchKeyTransfers(
  source: TraceDataSource = defaultTraceDataSource,
): Promise<PendingKeyTransfer[]> {
  return localAuth<PendingKeyTransfer[]>("/transfers", undefined, source);
}

/**
 * Join one request's exchange, which is what produces a code to compare. Safe
 * to repeat: the serving process re-uses the offer it already made rather than
 * starting a second exchange.
 */
export function openKeyTransfer(
  requestId: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<KeyTransferInspection> {
  return localAuth<KeyTransferInspection>(
    `/transfers/${encodeURIComponent(requestId)}/open`,
    { method: "POST" },
    source,
  );
}

/** Send this account's document key, on the user's word that the codes match. */
export function approveKeyTransfer(
  requestId: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<KeyTransferInspection> {
  return localAuth<KeyTransferInspection>(
    `/transfers/${encodeURIComponent(requestId)}/approve`,
    { method: "POST" },
    source,
  );
}

export function denyKeyTransfer(
  requestId: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<KeyTransferInspection> {
  return localAuth<KeyTransferInspection>(
    `/transfers/${encodeURIComponent(requestId)}/deny`,
    { method: "POST" },
    source,
  );
}

/**
 * Requests waiting on this machine's approval, asked at the login rhythm while
 * the account popover is open: the user is being asked to compare codes with
 * someone standing at another machine, and a background-rhythm answer would be
 * stale before they read it.
 */
export function useKeyTransfers(enabled: boolean) {
  const source = useTraceDataSource();
  return useQuery({
    queryKey: traceQueryKey(source, "key-transfers"),
    queryFn: () => fetchKeyTransfers(source),
    enabled,
    refetchInterval: LOGIN_POLL_MS,
  });
}

export function postLogout(
  source: TraceDataSource = defaultTraceDataSource,
): Promise<{ ok: true }> {
  return localAuth<{ ok: true }>("/logout", { method: "POST" }, source);
}

/** Login attempt states the board stops polling on. */
const SETTLED_LOGIN_STATES: ReadonlySet<LoginAttemptView["state"]> = new Set([
  "complete",
  "failed",
  "expired",
  "cancelled",
]);

/**
 * How often the board asks how a login is going. Faster than the board's
 * background {@link LIVE_REFRESH} rhythm because a login is a foreground
 * interaction the user is standing in front of — and it stops entirely as soon
 * as the attempt settles, so it is never a second always-on polling loop.
 */
const LOGIN_POLL_MS = 2000;

/**
 * Asked once each time the account popover opens, and not polled: the answer
 * only changes through this board's own actions, which update it in place.
 */
export function useCurrentLogin() {
  const source = useTraceDataSource();
  return useQuery({
    queryKey: traceQueryKey(source, "current-login"),
    queryFn: () => fetchCurrentLogin(source),
  });
}

/**
 * Whether a machine has answered that it does not know this attempt.
 *
 * Attempts live in the serving process's memory, so this is what a restarted
 * `eqnx serve` says about the login a board tab is still watching. It is a
 * settled answer, not a hiccup: asking again cannot bring the attempt back.
 */
export function isForgottenLogin(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}

export function useLoginAttempt(attemptId: string | null) {
  const source = useTraceDataSource();
  return useQuery({
    queryKey: traceQueryKey(source, "login-attempt", attemptId),
    queryFn: () => fetchLoginAttempt(attemptId as string, source),
    enabled: attemptId !== null,
    retry: (failureCount, error) => !isForgottenLogin(error) && failureCount < 3,
    refetchInterval: (query) => {
      if (isForgottenLogin(query.state.error)) return false;
      return query.state.data && SETTLED_LOGIN_STATES.has(query.state.data.state)
        ? false
        : LOGIN_POLL_MS;
    },
  });
}

export async function downloadTaskExport(
  ref: string,
  options: { includeTranscripts?: boolean } = {},
  source: TraceDataSource = defaultTraceDataSource,
): Promise<void> {
  const query = options.includeTranscripts === true ? "?transcripts=1" : "";
  const res = await source.request(
    `/api/tasks/${encodeURIComponent(ref)}/export${query}`,
  );
  if (!res.ok) {
    throw new HttpError(res.status, `GET export ${ref} failed: ${res.status}`);
  }
  const blob = await res.blob();
  const fileName =
    filenameFromContentDisposition(res.headers.get("content-disposition")) ??
    `${ref}.zip`;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (header === null) return null;
  const quoted = /filename="([^"]+)"/.exec(header);
  if (quoted?.[1]) return quoted[1];
  const unquoted = /filename=([^;]+)/.exec(header);
  return unquoted?.[1]?.trim() ?? null;
}

export async function postArchive(
  ref: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<{ id: string; archivedAt: string | null }> {
  const res = await source.request(
    `/api/tasks/${encodeURIComponent(ref)}/archive`,
    { method: "POST" },
  );
  if (!res.ok)
    throw new HttpError(
      res.status,
      `POST archive ${ref} failed: ${res.status}`,
    );
  return res.json() as Promise<{ id: string; archivedAt: string | null }>;
}

export async function postUnarchive(
  ref: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<{ id: string; archivedAt: string | null }> {
  const res = await source.request(
    `/api/tasks/${encodeURIComponent(ref)}/unarchive`,
    { method: "POST" },
  );
  if (!res.ok)
    throw new HttpError(
      res.status,
      `POST unarchive ${ref} failed: ${res.status}`,
    );
  return res.json() as Promise<{ id: string; archivedAt: string | null }>;
}

export async function postPin(
  ref: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<{ id: string; pinnedAt: string | null }> {
  const res = await source.request(
    `/api/tasks/${encodeURIComponent(ref)}/pin`,
    {
      method: "POST",
    },
  );
  if (!res.ok)
    throw new HttpError(res.status, `POST pin ${ref} failed: ${res.status}`);
  return res.json() as Promise<{ id: string; pinnedAt: string | null }>;
}

export async function postUnpin(
  ref: string,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<{ id: string; pinnedAt: string | null }> {
  const res = await source.request(
    `/api/tasks/${encodeURIComponent(ref)}/unpin`,
    { method: "POST" },
  );
  if (!res.ok)
    throw new HttpError(res.status, `POST unpin ${ref} failed: ${res.status}`);
  return res.json() as Promise<{ id: string; pinnedAt: string | null }>;
}

export async function postToggleCheckbox(
  ref: string,
  path: string,
  index: number,
  checked: boolean,
  source: TraceDataSource = defaultTraceDataSource,
): Promise<{ ok: true }> {
  const res = await source.request(
    `/api/tasks/${encodeURIComponent(ref)}/docs/checkbox`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, index, checked }),
    },
  );
  if (!res.ok) {
    throw new HttpError(
      res.status,
      `POST checkbox ${ref} failed: ${res.status}`,
    );
  }
  return res.json() as Promise<{ ok: true }>;
}

// Poll while the tab is visible so writes from other processes (binds, subagent
// discovery, hooks) land on an open board without a manual reload; never polls a
// backgrounded tab.
const LIVE_REFRESH = {
  refetchInterval: 1000 * 5,
  refetchIntervalInBackground: false,
} as const;

export function useTasks() {
  const source = useTraceDataSource();
  return useQuery({
    queryKey: traceQueryKey(source, "tasks"),
    queryFn: () => fetchTasks(source),
    ...LIVE_REFRESH,
  });
}

export function useSyncStatus() {
  const source = useTraceDataSource();
  return useQuery({
    queryKey: traceQueryKey(source, "sync-status"),
    queryFn: () => fetchSyncStatus(source),
    ...LIVE_REFRESH,
  });
}

export function useTaskTimeline(id: string) {
  const source = useTraceDataSource();
  return useQuery({
    queryKey: traceQueryKey(source, "task-timeline", id),
    queryFn: () => fetchTaskTimeline(id, source),
    ...LIVE_REFRESH,
  });
}

export function useDocContents(ref: string, docPath: string) {
  const source = useTraceDataSource();
  return useQuery({
    queryKey: traceQueryKey(source, "doc-contents", ref, docPath),
    queryFn: () => fetchDocContents(ref, docPath, source),
  });
}

export function useArchiveTask() {
  const qc = useQueryClient();
  const source = useTraceDataSource();
  return useMutation({
    mutationFn: (ref: string) => postArchive(ref, source),
    onSuccess: (_data, ref) => {
      void qc.invalidateQueries({ queryKey: traceQueryKey(source, "tasks") });
      void qc.invalidateQueries({
        queryKey: traceQueryKey(source, "task-timeline", ref),
      });
    },
  });
}

export function useToggleCheckbox() {
  const qc = useQueryClient();
  const source = useTraceDataSource();
  return useMutation({
    mutationFn: ({
      ref,
      path,
      index,
      checked,
    }: {
      ref: string;
      path: string;
      index: number;
      checked: boolean;
    }) => postToggleCheckbox(ref, path, index, checked, source),
    // Reconcile the rendered doc with disk on both success and error. On error
    // the optimistic DOM flip is reverted by the click handler; refetching the
    // doc-contents also restores the authoritative render.
    onSettled: (_data, _err, { ref, path }) => {
      void qc.invalidateQueries({
        queryKey: traceQueryKey(source, "doc-contents", ref, path),
      });
    },
  });
}

export function useUnarchiveTask() {
  const qc = useQueryClient();
  const source = useTraceDataSource();
  return useMutation({
    mutationFn: (ref: string) => postUnarchive(ref, source),
    onSuccess: (_data, ref) => {
      void qc.invalidateQueries({ queryKey: traceQueryKey(source, "tasks") });
      void qc.invalidateQueries({
        queryKey: traceQueryKey(source, "task-timeline", ref),
      });
    },
  });
}

export function usePinTask() {
  const qc = useQueryClient();
  const source = useTraceDataSource();
  return useMutation({
    mutationFn: (ref: string) => postPin(ref, source),
    onSuccess: (_data, ref) => {
      void qc.invalidateQueries({ queryKey: traceQueryKey(source, "tasks") });
      void qc.invalidateQueries({
        queryKey: traceQueryKey(source, "task-timeline", ref),
      });
    },
  });
}

export function useUnpinTask() {
  const qc = useQueryClient();
  const source = useTraceDataSource();
  return useMutation({
    mutationFn: (ref: string) => postUnpin(ref, source),
    onSuccess: (_data, ref) => {
      void qc.invalidateQueries({ queryKey: traceQueryKey(source, "tasks") });
      void qc.invalidateQueries({
        queryKey: traceQueryKey(source, "task-timeline", ref),
      });
    },
  });
}
