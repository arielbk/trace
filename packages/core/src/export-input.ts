import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  buildExportBundle,
  exportFolderName,
  type ExportBundleInput,
  type ExportDocInput,
  type ExportSessionInput,
} from "./export-bundle.ts";
import { zipExportBundle } from "./export-zip.ts";
import { getTranscriptAdapter } from "./transcript-adapter.ts";
import { resolveTaskDocsDir } from "./task-docs.ts";
import type { Session, TaskDoc, TaskStore } from "./types.ts";

export type GatherExportInputOptions = {
  exportedAt?: string;
  generator?: string;
  includeTranscripts?: boolean;
};

export type TaskExportZip = {
  bytes: Uint8Array;
  fileName: string;
};

export function gatherExportInput(
  store: TaskStore,
  databasePath: string,
  taskRef: string,
  options: GatherExportInputOptions = {},
): ExportBundleInput | null {
  const timeline = store.getTaskTimeline(taskRef);
  if (!timeline) return null;

  const docsDir = resolveTaskDocsDir(databasePath, timeline.task.slug);
  const project = store.getProject(timeline.task.projectId);
  const docs = timeline.items
    .filter((item) => item.type === "doc")
    .map((item) => toExportDoc(item.doc, docsDir))
    .filter((doc): doc is ExportDocInput => doc !== null);
  const sessions = timeline.items
    .filter((item) => item.type === "session")
    .map((item) =>
      toExportSession(
        item.session,
        options.includeTranscripts === true ? store.getMachineId() : undefined,
      ),
    );

  const task: ExportBundleInput["task"] = {
    id: timeline.task.id,
    slug: timeline.task.slug,
    title: timeline.task.title,
    createdAt: timeline.task.createdAt,
  };
  if (timeline.task.description) task.description = timeline.task.description;

  const projectBlock: ExportBundleInput["project"] = {
    slug: project?.slug ?? timeline.task.projectSlug,
  };
  if (project?.remoteUrl) projectBlock.remote = project.remoteUrl;

  const input: ExportBundleInput = {
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    task,
    project: projectBlock,
    docs,
    sessions,
  };
  if (options.generator) input.generator = options.generator;
  return input;
}

export function buildTaskExportZip(
  store: TaskStore,
  databasePath: string,
  taskRef: string,
  options: GatherExportInputOptions = {},
): TaskExportZip | null {
  const input = gatherExportInput(store, databasePath, taskRef, options);
  if (!input) return null;
  return {
    bytes: zipExportBundle(buildExportBundle(input)),
    fileName: `${exportFolderName(input.task.slug, input.exportedAt)}.zip`,
  };
}

function toExportDoc(doc: TaskDoc, docsDir: string): ExportDocInput | null {
  let contents: Uint8Array;
  try {
    contents = new Uint8Array(readFileSync(doc.path));
  } catch {
    return null;
  }
  const exportDoc: ExportDocInput = {
    sourcePath: doc.path,
    contents,
    source: isUnderDocsDir(doc.path, docsDir) ? "native" : "registered",
  };
  if (doc.title) exportDoc.title = doc.title;
  if (doc.description) exportDoc.description = doc.description;
  return exportDoc;
}

function toExportSession(
  session: Session,
  localMachineId?: string,
): ExportSessionInput {
  const exported: ExportSessionInput = {
    id: session.id,
    tool: session.tool,
    model: session.model,
    origin: session.origin,
    parentSessionId: session.parentSessionId,
    subagentType: session.subagentType,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? session.createdAt,
    machineId: session.machineId ?? "",
    tokens: session.tokenTotals,
  };
  if (localMachineId !== undefined) {
    exported.transcript = getTranscriptAdapter(session.tool).exportTranscript({
      transcriptPath: session.transcriptPath,
      sessionMachineId: session.machineId ?? "",
      localMachineId,
    });
  }
  return exported;
}

function isUnderDocsDir(path: string, docsDir: string): boolean {
  const resolved = resolve(path);
  const root = resolve(docsDir);
  return resolved === root || resolved.startsWith(`${root}${sep}`);
}
