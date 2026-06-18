import {
  resolveSessionName,
  resolveTaskDocsDir,
  type ActiveTask,
  type ReEntryManifest,
  type Session,
  type Task,
  type TaskDoc,
} from "@trace/core";

export function formatTask(task: Task, sessions: Session[] = [], docs: TaskDoc[] = []): string {
  const lines = [
    `slug: ${task.slug}`,
    `id: ${task.id}`,
    `title: ${task.title}`,
    ...(task.description ? [`description: ${task.description}`] : []),
    `createdAt: ${task.createdAt}`,
    `projectRoot: ${task.projectRoot}`,
  ];

  if (sessions.length > 0) {
    lines.push(
      "sessions:",
      ...sessions.map((session) => `- ${formatSessionSummary(session).trimEnd()}`),
    );
  }

  if (docs.length > 0) {
    lines.push("docs:", ...docs.map((doc) => `- ${doc.path}`));
  }

  return [...lines, ""].join("\n");
}

export function formatTaskSummary(task: Task): string {
  return `${task.slug}\t${task.title}\n`;
}

export function formatSessionSummary(session: Session): string {
  // The resolved conversation name (stored title, else first-line synthesis)
  // rides as a trailing column so the leading id/tool/transcript fields other
  // tooling reads stay put; it is omitted entirely when no name resolves.
  const name = resolveSessionName(session);
  const base = `${session.id}\t${session.tool}\t${session.transcriptPath}`;
  return name ? `${base}\t${name}\n` : `${base}\n`;
}

export function formatTaskDocSummary(taskRef: string, doc: TaskDoc): string {
  return `${taskRef}\t${doc.path}\n`;
}

export function formatActiveTask(
  activeTask: ActiveTask,
): { kind: "none" } | { kind: "bound" | "re-enter"; task: { title: string; slug: string } } {
  if (activeTask.kind === "none") return { kind: "none" };
  return { kind: activeTask.kind, task: { title: activeTask.task.title, slug: activeTask.task.slug } };
}

export function resolveSkillTaskRef(
  tasks: Task[],
  ref: string,
  getById: (id: string) => Task | null,
): Task | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;

  const byId = getById(trimmed);
  if (byId) return byId;

  const bySlug = tasks.find((task) => task.slug === trimmed);
  if (bySlug) return bySlug;

  const normalized = trimmed.toLowerCase();
  const byTitle = tasks.find(
    (task) => task.title.trim().toLowerCase() === normalized,
  );
  return byTitle ?? null;
}

export function taskNotFoundMessage(tasks: Task[], ref: string): string {
  const needle = ref.trim().toLowerCase();
  const near = tasks
    .filter(
      (task) =>
        needle.length > 0 &&
        (task.slug.includes(needle) || task.title.toLowerCase().includes(needle)),
    )
    .slice(0, 5);

  const lines = [`Task not found: ${ref}`];
  if (near.length > 0) {
    lines.push("Near candidates:");
    for (const task of near) {
      lines.push(`  ${task.slug} — ${task.title}`);
    }
  }
  return lines.join("\n");
}

export function formatSkillWorkOnTaskResult(
  session: Session,
  task: Task,
  databasePath: string,
): string {
  if (!session.taskId) {
    return formatSessionSummary(session);
  }

  return [
    formatSessionSummary(session).trimEnd(),
    `taskDocsDir: ${resolveTaskDocsDir(databasePath, task.slug)}`,
    "",
  ].join("\n");
}

export function formatReEntryManifest(manifest: ReEntryManifest): string {
  const lines = [
    "task:",
    `  id: ${manifest.task.id}`,
    `  title: ${manifest.task.title}`,
    ...(manifest.task.description
      ? [`  description: ${manifest.task.description}`]
      : []),
    `  projectRoot: ${manifest.task.projectRoot}`,
  ];

  if (manifest.state) {
    lines.push("state:", `  path: ${manifest.state.path}`);
  }

  lines.push(`taskDocsDir: ${manifest.taskDocsDir}`);

  if (manifest.docs.length === 0) {
    lines.push("docs: []");
  } else {
    lines.push("docs:", ...manifest.docs.map((doc) => `- path: ${doc.path}`));
  }

  if (manifest.sessions.length === 0) {
    lines.push("sessions: []");
  } else {
    lines.push(
      "sessions:",
      ...manifest.sessions.flatMap((session) => [
        `- id: ${session.id}`,
        `  tool: ${session.tool}`,
        `  transcript: ${session.transcriptPath}`,
        `  mostRecent: ${session.isMostRecent ? "true" : "false"}`,
        ...(session.model ? [`  model: ${session.model}`] : []),
      ]),
    );
  }

  return [...lines, ""].join("\n");
}
