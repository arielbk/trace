import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskSummary, TaskTimeline } from "@trace/core/browser";

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
  /** Resolved display title (explicit title → first H1 → filename). */
  title: string;
  /** One-line description, present only when the doc was registered with one. */
  description?: string;
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
  const title = decodeHeader(res.headers.get("x-doc-title")) ?? basename(docPath);
  const description = decodeHeader(res.headers.get("x-doc-description"));
  return { contentType, body, title, ...(description ? { description } : {}) };
}

/** Decode a url-encoded response header, tolerating malformed input. */
function decodeHeader(value: string | null): string | undefined {
  if (value === null) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Final path segment — the filename fallback when no title header is sent. */
function basename(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? path;
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
