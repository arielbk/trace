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

export function useTasks() {
  return useQuery({ queryKey: ["tasks"], queryFn: fetchTasks });
}

export function useTaskTimeline(id: string) {
  return useQuery({ queryKey: ["task-timeline", id], queryFn: () => fetchTaskTimeline(id) });
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
