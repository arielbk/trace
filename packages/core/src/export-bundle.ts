import type {
  ExportedTranscript,
  TranscriptExportStatus,
  TranscriptFormat,
} from "./export-transcript.ts";
import { addTokenTotals, emptyTokenTotals, freshTokenTotal } from "./token-totals.ts";
import type { SessionOrigin, SessionTool, TokenTotals } from "./types.ts";

export type BundleFile = {
  path: string;
  contents: string | Uint8Array;
};

export type ExportDocInput = {
  sourcePath: string;
  contents: string | Uint8Array;
  title?: string;
  description?: string;
  source: "native" | "registered";
};

export type ExportSessionInput = {
  id: string;
  tool: SessionTool;
  model: string | null;
  origin: SessionOrigin;
  parentSessionId: string | null;
  subagentType: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  machineId: string;
  tokens: TokenTotals;
  transcript?: ExportedTranscript;
};

export type ExportBundleInput = {
  exportedAt: string;
  generator?: string;
  task: {
    id: string;
    slug: string;
    title: string;
    description?: string;
    createdAt: string;
  };
  project: {
    slug: string;
    remote?: string | null;
  };
  docs: ExportDocInput[];
  sessions: ExportSessionInput[];
};

export type ExportManifestTokens = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
};

export type ExportManifestDoc = {
  path: string;
  title?: string;
  description?: string;
  source: "native" | "registered";
  sourcePath: string;
};

export type ExportManifestSession = {
  id: string;
  tool: SessionTool;
  model: string | null;
  origin: SessionOrigin;
  parentSessionId: string | null;
  subagentType: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  machineId: string;
  tokens: ExportManifestTokens;
  transcript?: {
    status: TranscriptExportStatus;
    format?: TranscriptFormat;
    path?: string;
  };
};

export type ExportManifest = {
  formatVersion: 1;
  generator?: string;
  exportedAt: string;
  task: ExportBundleInput["task"];
  project: {
    slug: string;
    remote?: string;
  };
  docs: ExportManifestDoc[];
  sessions: ExportManifestSession[];
  totals: {
    rootSessions: number;
    subagentSessions: number;
    spawnedSessions: number;
    tokens: ExportManifestTokens;
    freshTotal: number;
    firstSessionAt?: string;
    lastSessionAt?: string;
    tools: SessionTool[];
    models: string[];
  };
};

export function exportFolderName(slug: string, exportedAt: string): string {
  return `${slug}-${exportedAt.slice(0, 10)}`;
}

export function manifestTokens(totals: TokenTotals): ExportManifestTokens {
  return {
    input: totals.inputTokens,
    output: totals.outputTokens,
    cacheCreation: totals.cacheCreationInputTokens,
    cacheRead: totals.cacheReadInputTokens,
    total: totals.totalTokens,
  };
}

export function buildExportBundle(input: ExportBundleInput): BundleFile[] {
  const folder = exportFolderName(input.task.slug, input.exportedAt);
  const placedDocs = placeDocs(input.docs);
  const manifest = buildManifest(input, placedDocs);
  const files: BundleFile[] = [
    { path: `${folder}/README.md`, contents: renderReadme(manifest) },
    {
      path: `${folder}/manifest.json`,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];

  if (placedDocs.length === 0) {
    files.push({ path: `${folder}/docs/`, contents: new Uint8Array() });
  } else {
    for (const doc of placedDocs) {
      files.push({
        path: `${folder}/${doc.path}`,
        contents: doc.contents,
      });
    }
  }

  for (const session of input.sessions) {
    const transcript = session.transcript;
    if (transcript?.status !== "included") continue;
    files.push({
      path: `${folder}/${transcriptBundlePath(session.id, transcript.extension)}`,
      contents: transcript.bytes,
    });
  }

  return files;
}

function buildManifest(
  input: ExportBundleInput,
  placedDocs: PlacedDoc[],
): ExportManifest {
  const tokens = sumSessionTokens(input.sessions);
  const timestamps = input.sessions.map((session) => session.createdAt).sort();
  const tools = [...new Set(input.sessions.map((session) => session.tool))];
  const models = [
    ...new Set(
      input.sessions
        .map((session) => session.model)
        .filter((model): model is string => model != null && model.length > 0),
    ),
  ];

  const project: ExportManifest["project"] = { slug: input.project.slug };
  if (input.project.remote) project.remote = input.project.remote;

  const manifest: ExportManifest = {
    formatVersion: 1,
    ...(input.generator ? { generator: input.generator } : {}),
    exportedAt: input.exportedAt,
    task: input.task.description
      ? input.task
      : {
          id: input.task.id,
          slug: input.task.slug,
          title: input.task.title,
          createdAt: input.task.createdAt,
        },
    project,
    docs: placedDocs.map((doc) => {
      const entry: ExportManifestDoc = {
        path: doc.path,
        source: doc.source,
        sourcePath: doc.sourcePath,
      };
      if (doc.title) entry.title = doc.title;
      if (doc.description) entry.description = doc.description;
      return entry;
    }),
    sessions: input.sessions.map((session) => {
      const row: ExportManifestSession = {
        id: session.id,
        tool: session.tool,
        model: session.model,
        origin: session.origin,
        parentSessionId: session.parentSessionId,
        subagentType: session.subagentType,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        machineId: session.machineId,
        tokens: manifestTokens(session.tokens),
      };
      if (session.transcript) {
        row.transcript = manifestTranscript(session.id, session.transcript);
      }
      return row;
    }),
    totals: {
      rootSessions: countOrigin(input.sessions, "root"),
      subagentSessions: countOrigin(input.sessions, "subagent"),
      spawnedSessions: countOrigin(input.sessions, "spawned"),
      tokens: manifestTokens(tokens),
      freshTotal: freshTokenTotal(tokens),
      ...(timestamps[0] ? { firstSessionAt: timestamps[0] } : {}),
      ...(timestamps.at(-1) ? { lastSessionAt: timestamps.at(-1) } : {}),
      tools,
      models,
    },
  };

  return manifest;
}

function renderReadme(manifest: ExportManifest): string {
  const lines: string[] = [`# ${manifest.task.title}`, ""];
  if (manifest.task.description) {
    lines.push(manifest.task.description, "");
  }
  lines.push(
    `- Task: ${manifest.task.slug} (${manifest.task.id})`,
    `- Created: ${manifest.task.createdAt}`,
    `- Project: ${manifest.project.slug}${manifest.project.remote ? ` (${manifest.project.remote})` : ""}`,
    `- Exported: ${manifest.exportedAt}`,
  );
  if (manifest.generator) {
    lines.push(`- Generator: ${manifest.generator}`);
  }
  lines.push(`- Format version: ${manifest.formatVersion}`, "");

  const { totals } = manifest;
  lines.push(
    "## Totals",
    "",
    `- Root sessions: ${totals.rootSessions}`,
    `- Subagent sessions: ${totals.subagentSessions}`,
    `- Spawned sessions: ${totals.spawnedSessions}`,
    `- Tokens: input ${totals.tokens.input}, output ${totals.tokens.output}, cacheCreation ${totals.tokens.cacheCreation}, cacheRead ${totals.tokens.cacheRead}, total ${totals.tokens.total}`,
    `- Fresh tokens: ${totals.freshTotal}`,
  );
  if (totals.firstSessionAt) {
    lines.push(`- First session: ${totals.firstSessionAt}`);
  }
  if (totals.lastSessionAt) {
    lines.push(`- Last session: ${totals.lastSessionAt}`);
  }
  if (totals.tools.length > 0) {
    lines.push(`- Tools: ${totals.tools.join(", ")}`);
  }
  if (totals.models.length > 0) {
    lines.push(`- Models: ${totals.models.join(", ")}`);
  }
  lines.push("");

  if (manifest.sessions.length > 0) {
    lines.push("## Sessions", "");
    for (const session of manifest.sessions) {
      const model = session.model ? ` ${session.model}` : "";
      const title = session.title ? ` — ${session.title}` : "";
      lines.push(
        `- ${session.id} — ${session.tool}${model} (${session.origin})${title}`,
      );
    }
    lines.push("");
  }

  if (manifest.docs.length > 0) {
    lines.push("## Docs", "");
    for (const doc of manifest.docs) {
      const title = doc.title ? ` — ${doc.title}` : "";
      lines.push(`- ${doc.path}${title}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}`;
}

type PlacedDoc = ExportManifestDoc & { contents: string | Uint8Array };

function placeDocs(docs: ExportDocInput[]): PlacedDoc[] {
  const used = new Set<string>();
  const placed: PlacedDoc[] = [];
  const ordered = [...docs].sort(compareDocs);

  for (const doc of ordered) {
    const path = uniqueDocPath(basename(doc.sourcePath), used);
    used.add(path);
    placed.push({
      path,
      source: doc.source,
      sourcePath: doc.sourcePath,
      contents: doc.contents,
      ...(doc.title ? { title: doc.title } : {}),
      ...(doc.description ? { description: doc.description } : {}),
    });
  }

  return placed;
}

function compareDocs(left: ExportDocInput, right: ExportDocInput): number {
  const leftState = basename(left.sourcePath) === "state.md" ? 0 : 1;
  const rightState = basename(right.sourcePath) === "state.md" ? 0 : 1;
  if (leftState !== rightState) return leftState - rightState;
  return left.sourcePath.localeCompare(right.sourcePath);
}

function uniqueDocPath(fileName: string, used: Set<string>): string {
  const candidate = `docs/${fileName}`;
  if (!used.has(candidate)) return candidate;

  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  for (let suffix = 2; ; suffix += 1) {
    const next = `docs/${stem}-${suffix}${extension}`;
    if (!used.has(next)) return next;
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function transcriptBundlePath(sessionId: string, extension: ".jsonl" | ".json"): string {
  return `transcripts/${encodeURIComponent(sessionId)}${extension}`;
}

function manifestTranscript(
  sessionId: string,
  transcript: ExportedTranscript,
): NonNullable<ExportManifestSession["transcript"]> {
  if (transcript.status !== "included") {
    return { status: transcript.status };
  }
  return {
    status: "included",
    format: transcript.format,
    path: transcriptBundlePath(sessionId, transcript.extension),
  };
}

function countOrigin(
  sessions: ExportSessionInput[],
  origin: SessionOrigin,
): number {
  return sessions.filter((session) => session.origin === origin).length;
}

function sumSessionTokens(sessions: ExportSessionInput[]): TokenTotals {
  return sessions.reduce(
    (totals, session) => addTokenTotals(totals, session.tokens),
    emptyTokenTotals(),
  );
}
