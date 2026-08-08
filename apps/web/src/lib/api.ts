import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  LoginAttemptView,
  LoginProvider,
  SyncStatusResponse,
  TaskSummary,
  TaskTimeline,
} from "@trace/core/browser";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function fetchTasks(): Promise<TaskSummary[]> {
  const res = await fetch("/api/tasks");
  if (!res.ok) throw new HttpError(res.status, `GET /api/tasks failed: ${res.status}`);
  return res.json() as Promise<TaskSummary[]>;
}

export async function fetchTaskTimeline(id: string): Promise<TaskTimeline> {
  const res = await fetch(`/api/tasks/${id}/timeline`);
  if (!res.ok) throw new HttpError(res.status, `GET /api/tasks/${id}/timeline failed: ${res.status}`);
  return res.json() as Promise<TaskTimeline>;
}

export type DocContents = {
  contentType: string;
  body: string;
};

export async function fetchDocContents(ref: string, docPath: string): Promise<DocContents> {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(ref)}/docs?path=${encodeURIComponent(docPath)}`,
  );
  const contentType = res.headers.get("content-type") ?? "text/plain";
  const body = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, body || `GET docs for ${docPath} failed: ${res.status}`);
  }
  return { contentType, body };
}

export async function fetchSyncStatus(): Promise<SyncStatusResponse> {
  const res = await fetch("/api/sync/status");
  if (!res.ok) throw new HttpError(res.status, `GET /api/sync/status failed: ${res.status}`);
  return res.json() as Promise<SyncStatusResponse>;
}

/** Ask the serving process to run a background sync now (fire-and-forget).
 * The server throttles repeat requests, so callers can fire freely; failures
 * (a dev server with no sync trigger, a network hiccup) never surface. */
export function requestServerSync(): void {
  void fetch("/api/sync", { method: "POST" }).catch(() => {});
}

/**
 * Request a server-side sync on mount and whenever the board window regains
 * focus. The polling queries only read the local database; this asks the
 * server to converge that database with other machines first, so acting on a
 * just-focused board (pin, archive) starts from fresh rows instead of stale
 * ones — shrinking the cross-machine last-write-wins clobber window.
 */
export function useServerSyncOnFocus(): void {
  useEffect(() => {
    requestServerSync();
    window.addEventListener("focus", requestServerSync);
    return () => window.removeEventListener("focus", requestServerSync);
  }, []);
}

/**
 * The machine-local authentication endpoints. The board only ever starts,
 * watches, and settles a login attempt — the serving process holds the bearer
 * token, and no response here carries it.
 */
async function localAuth<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`/api/local-auth${path}`, init);
  if (!res.ok) {
    const detail = await res.text();
    throw new HttpError(res.status, detail || `local-auth ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function startLogin(provider: LoginProvider): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

export function fetchLoginAttempt(attemptId: string): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(`/login/${encodeURIComponent(attemptId)}`);
}

/**
 * The login this machine is still in the middle of, or `null` when there is
 * none. A board tab's handle on an attempt lasts only as long as the popover
 * holding it, so this is what a freshly opened popover asks to find a login
 * someone walked away from — an approved attempt stopped at the key prompt
 * above all, which the serving process cannot finish on its own.
 */
export function fetchCurrentLogin(): Promise<LoginAttemptView | null> {
  return localAuth<LoginAttemptView | null>("/login/current");
}

export function acknowledgeGeneratedKey(attemptId: string): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/acknowledge-key`,
    { method: "POST" },
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
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/existing-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    },
  );
}

/** Abandon the account's existing documents in favour of a fresh key. */
export function generateReplacementKey(
  attemptId: string,
  confirmation: string,
): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/replacement-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    },
  );
}

export function cancelLogin(attemptId: string): Promise<LoginAttemptView> {
  return localAuth<LoginAttemptView>(
    `/login/${encodeURIComponent(attemptId)}/cancel`,
    { method: "POST" },
  );
}

export function postLogout(): Promise<{ ok: true }> {
  return localAuth<{ ok: true }>("/logout", { method: "POST" });
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
  return useQuery({
    queryKey: ["current-login"],
    queryFn: fetchCurrentLogin,
  });
}

export function useLoginAttempt(attemptId: string | null) {
  return useQuery({
    queryKey: ["login-attempt", attemptId],
    queryFn: () => fetchLoginAttempt(attemptId as string),
    enabled: attemptId !== null,
    refetchInterval: (query) =>
      query.state.data && SETTLED_LOGIN_STATES.has(query.state.data.state)
        ? false
        : LOGIN_POLL_MS,
  });
}

export async function postArchive(ref: string): Promise<{ id: string; archivedAt: string | null }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}/archive`, { method: "POST" });
  if (!res.ok) throw new HttpError(res.status, `POST archive ${ref} failed: ${res.status}`);
  return res.json() as Promise<{ id: string; archivedAt: string | null }>;
}

export async function postUnarchive(ref: string): Promise<{ id: string; archivedAt: string | null }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}/unarchive`, { method: "POST" });
  if (!res.ok) throw new HttpError(res.status, `POST unarchive ${ref} failed: ${res.status}`);
  return res.json() as Promise<{ id: string; archivedAt: string | null }>;
}

export async function postPin(ref: string): Promise<{ id: string; pinnedAt: string | null }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}/pin`, { method: "POST" });
  if (!res.ok) throw new HttpError(res.status, `POST pin ${ref} failed: ${res.status}`);
  return res.json() as Promise<{ id: string; pinnedAt: string | null }>;
}

export async function postUnpin(ref: string): Promise<{ id: string; pinnedAt: string | null }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}/unpin`, { method: "POST" });
  if (!res.ok) throw new HttpError(res.status, `POST unpin ${ref} failed: ${res.status}`);
  return res.json() as Promise<{ id: string; pinnedAt: string | null }>;
}

export async function postToggleCheckbox(
  ref: string,
  path: string,
  index: number,
  checked: boolean,
): Promise<{ ok: true }> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}/docs/checkbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, index, checked }),
  });
  if (!res.ok) {
    throw new HttpError(res.status, `POST checkbox ${ref} failed: ${res.status}`);
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
  return useQuery({ queryKey: ["tasks"], queryFn: fetchTasks, ...LIVE_REFRESH });
}

export function useSyncStatus() {
  return useQuery({
    queryKey: ["sync-status"],
    queryFn: fetchSyncStatus,
    ...LIVE_REFRESH,
  });
}

export function useTaskTimeline(id: string) {
  return useQuery({
    queryKey: ["task-timeline", id],
    queryFn: () => fetchTaskTimeline(id),
    ...LIVE_REFRESH,
  });
}

export function useDocContents(ref: string, docPath: string) {
  return useQuery({
    queryKey: ["doc-contents", ref, docPath],
    queryFn: () => fetchDocContents(ref, docPath),
  });
}

export function useArchiveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postArchive,
    onSuccess: (_data, ref) => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["task-timeline", ref] });
    },
  });
}

export function useToggleCheckbox() {
  const qc = useQueryClient();
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
    }) => postToggleCheckbox(ref, path, index, checked),
    // Reconcile the rendered doc with disk on both success and error. On error
    // the optimistic DOM flip is reverted by the click handler; refetching the
    // doc-contents also restores the authoritative render.
    onSettled: (_data, _err, { ref, path }) => {
      void qc.invalidateQueries({ queryKey: ["doc-contents", ref, path] });
    },
  });
}

export function useUnarchiveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postUnarchive,
    onSuccess: (_data, ref) => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["task-timeline", ref] });
    },
  });
}

export function usePinTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postPin,
    onSuccess: (_data, ref) => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["task-timeline", ref] });
    },
  });
}

export function useUnpinTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postUnpin,
    onSuccess: (_data, ref) => {
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["task-timeline", ref] });
    },
  });
}
