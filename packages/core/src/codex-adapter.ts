import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";

export type CodexTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

export type ParsedCodexSession = {
  id: string;
  transcriptPath: string;
  tool: "codex";
  model: string | null;
  tokenTotals: CodexTokenTotals;
};

export type CodexTranscriptInput = {
  transcript: string;
  transcriptPath: string;
  expectedThreadId?: string | undefined;
};

type CodexUsage = {
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cache_creation_input_tokens?: number;
  cacheCreationInputTokens?: number;
  cache_read_input_tokens?: number;
  cacheReadInputTokens?: number;
  total_tokens?: number;
  totalTokens?: number;
};

type CodexJsonlEvent = {
  type?: string;
  thread_id?: string;
  threadId?: string;
  id?: string;
  model?: string;
  usage?: CodexUsage;
  turn?: {
    usage?: CodexUsage;
  };
};

type CodexSessionIndexEntry = {
  thread_id?: string;
  threadId?: string;
  id?: string;
  path?: string;
  transcript_path?: string;
  transcriptPath?: string;
  rollout_path?: string;
  rolloutPath?: string;
};

export function parseCodexTranscript(
  input: CodexTranscriptInput,
): ParsedCodexSession {
  let id: string | undefined;
  let model: string | undefined;
  const filenameId = codexThreadIdFromPath(input.transcriptPath);
  const tokenTotals: CodexTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };

  for (const line of input.transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    const event = JSON.parse(line) as CodexJsonlEvent;

    if (event.type === "thread.started") {
      id ??= event.thread_id ?? event.threadId ?? event.id;
      model ??= event.model;
    }

    if (event.type === "turn.completed") {
      addUsage(tokenTotals, event.usage ?? event.turn?.usage);
    }
  }

  if (!id) {
    throw new Error("Codex transcript does not include a thread.started id");
  }

  if (filenameId && filenameId !== id) {
    throw new Error(
      `Codex transcript id ${id} does not match filename id ${filenameId}`,
    );
  }

  if (input.expectedThreadId && input.expectedThreadId !== id) {
    throw new Error(
      `Codex transcript id ${id} does not match expected thread id ${input.expectedThreadId}`,
    );
  }

  return {
    id,
    transcriptPath: input.transcriptPath,
    tool: "codex",
    model: model ?? null,
    tokenTotals,
  };
}

export function parseCodexTranscriptFile(
  transcriptPath: string,
  options: { expectedThreadId?: string | undefined } = {},
): ParsedCodexSession {
  return parseCodexTranscript({
    transcript: readFileSync(transcriptPath, "utf8"),
    transcriptPath,
    expectedThreadId: options.expectedThreadId,
  });
}

export function scanCodexSessions(codexHome: string): ParsedCodexSession[] {
  const root = resolve(codexHome);
  const indexedPaths = readCodexSessionIndex(root);
  const transcriptPaths =
    indexedPaths.length > 0
      ? indexedPaths
      : findJsonlFiles(join(root, "sessions"));

  return transcriptPaths.map((entry) =>
    parseCodexTranscriptFile(entry.transcriptPath, {
      expectedThreadId: entry.expectedThreadId,
    }),
  );
}

function readCodexSessionIndex(
  codexHome: string,
): Array<{ transcriptPath: string; expectedThreadId?: string }> {
  const indexPath = join(codexHome, "session_index.jsonl");

  if (!existsSync(indexPath)) {
    return [];
  }

  return readFileSync(indexPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const entry = JSON.parse(line) as CodexSessionIndexEntry;
      const rawPath =
        entry.path ??
        entry.transcript_path ??
        entry.transcriptPath ??
        entry.rollout_path ??
        entry.rolloutPath;

      if (!rawPath) {
        throw new Error(
          "Codex session index entry is missing a transcript path",
        );
      }

      return {
        transcriptPath: resolve(codexHome, rawPath),
        expectedThreadId: entry.thread_id ?? entry.threadId ?? entry.id,
      };
    });
}

function findJsonlFiles(
  directoryPath: string,
): Array<{ transcriptPath: string; expectedThreadId?: string }> {
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath, { withFileTypes: true })
    .flatMap(
      (
        entry: Dirent,
      ): Array<{ transcriptPath: string; expectedThreadId?: string }> => {
        const fullPath = join(directoryPath, entry.name);

        if (entry.isDirectory()) {
          return findJsonlFiles(fullPath);
        }

        return entry.isFile() && entry.name.endsWith(".jsonl")
          ? [{ transcriptPath: fullPath }]
          : [];
      },
    )
    .sort((left, right) =>
      left.transcriptPath.localeCompare(right.transcriptPath),
    );
}

function codexThreadIdFromPath(transcriptPath: string): string | undefined {
  const filename = basename(transcriptPath).replace(/\.jsonl$/, "");
  return filename.length > 0 ? filename.replace(/^rollout-/, "") : undefined;
}

function addUsage(
  tokenTotals: CodexTokenTotals,
  usage: CodexUsage | undefined,
): void {
  if (!usage) {
    return;
  }

  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
  const cacheCreationInputTokens =
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens =
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0;

  tokenTotals.inputTokens += inputTokens;
  tokenTotals.outputTokens += outputTokens;
  tokenTotals.cacheCreationInputTokens += cacheCreationInputTokens;
  tokenTotals.cacheReadInputTokens += cacheReadInputTokens;
  tokenTotals.totalTokens +=
    usage.total_tokens ??
    usage.totalTokens ??
    inputTokens +
      outputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens;
}
