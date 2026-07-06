import {
  inferSessionIdentity,
  type SessionOrigin,
  type SessionTool,
  type SetSessionParentInput,
  type TokenTotals,
} from "@trace/core";
import { resolveCursorSession } from "@trace/cursor-reader";
import { looksLikeFlag, type Env } from "./seam.ts";

export function taskCreateUsage(): string {
  return "Usage: trace task create <title> [--description <text>] [--project <dir>]";
}

export function parseTaskCreateArgs(args: string[]): {
  title: string;
  description?: string;
  project?: string;
} {
  const titleWords: string[] = [];
  let description: string | undefined;
  let project: string | undefined;

  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    titleWords.push(args[index] as string);
    index += 1;
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--description") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCreateUsage());
      description = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCreateUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  const title = titleWords.join(" ");
  if (title.length === 0) throw new Error(taskCreateUsage());
  return { title, description, project };
}

export function taskUpdateUsage(): string {
  return "Usage: trace task update <ref> --description <text>";
}

export function parseTaskUpdateArgs(args: string[]): { ref: string; description: string } {
  const refWords: string[] = [];
  let description: string | undefined;

  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    refWords.push(args[index] as string);
    index += 1;
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--description") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(taskUpdateUsage());
      description = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  const ref = refWords.join(" ");
  if (ref.length === 0 || description === undefined) throw new Error(taskUpdateUsage());
  return { ref, description };
}

export function taskCaptureUsage(): string {
  return "Usage: trace task capture <title> [--doc <path>] [--title <doc-title>] [--description <text>] [--link] [--project <dir>]";
}

export function parseTaskCaptureArgs(args: string[]): {
  title: string;
  docPath?: string;
  docTitle?: string;
  description?: string;
  link: boolean;
  project?: string;
} {
  const titleWords: string[] = [];
  let docPath: string | undefined;
  let docTitle: string | undefined;
  let description: string | undefined;
  let link = false;
  let project: string | undefined;

  let index = 0;
  while (index < args.length && !looksLikeFlag(args[index])) {
    titleWords.push(args[index] as string);
    index += 1;
  }
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--doc") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCaptureUsage());
      docPath = value;
      index += 2;
    } else if (flag === "--title") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCaptureUsage());
      docTitle = value;
      index += 2;
    } else if (flag === "--description") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCaptureUsage());
      description = value;
      index += 2;
    } else if (flag === "--link") {
      link = true;
      index += 1;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(taskCaptureUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  const title = titleWords.join(" ");
  if (title.length === 0) throw new Error(taskCaptureUsage());
  return { title, docPath, docTitle, description, link, project };
}

export function addDocUsage(): string {
  return "Usage: trace task add-doc <ref> <path> [--title <text>] [--description <text>]";
}

export function parseAddDocOptions(flags: string[]): {
  title?: string;
  description?: string;
} {
  let title: string | undefined;
  let description: string | undefined;
  let index = 0;
  while (index < flags.length) {
    const flag = flags[index];
    if (flag === "--title") {
      const value = flags[index + 1];
      if (!value) throw new Error(addDocUsage());
      title = value;
      index += 2;
    } else if (flag === "--description") {
      const value = flags[index + 1];
      if (!value) throw new Error(addDocUsage());
      description = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return { title, description };
}

export function updateDocUsage(): string {
  return "Usage: trace task update-doc <ref> <path> [--title <text>] [--description <text>]";
}

export function parseUpdateDocOptions(flags: string[]): {
  title?: string | null;
  description?: string | null;
} {
  const result: { title?: string | null; description?: string | null } = {};
  let index = 0;
  while (index < flags.length) {
    const flag = flags[index];
    if (flag === "--title" || flag === "--description") {
      const value = flags[index + 1];
      if (value === undefined) throw new Error(updateDocUsage());
      // A present-but-empty (or whitespace) value clears the field; a non-empty
      // value sets the trimmed text. Absent flags never reach here, so they
      // stay omitted (untouched).
      const trimmed = value.trim();
      const normalized = trimmed.length === 0 ? null : trimmed;
      if (flag === "--title") result.title = normalized;
      else result.description = normalized;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  // Nothing to change is a usage error, not a silent no-op.
  if (result.title === undefined && result.description === undefined) {
    throw new Error(updateDocUsage());
  }
  return result;
}

export function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

export function sessionRegisterUsage(): string {
  return "Session register requires --id, --transcript, and --tool";
}

export function parseSessionRegisterArgs(args: string[]): {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  tokenTotals: Partial<TokenTotals>;
  model?: string | null;
  parentSessionId?: string | null;
  origin?: SessionOrigin;
} {
  let id: string | undefined;
  let transcriptPath: string | undefined;
  let tool: string | undefined;
  let model: string | null | undefined;
  let parentSessionId: string | null | undefined;
  let origin: string | undefined;
  const tokenTotals: Partial<TokenTotals> = {};

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) throw new Error(sessionRegisterUsage());

    if (flag === "--id") id = value;
    else if (flag === "--transcript") transcriptPath = value;
    else if (flag === "--tool") tool = value;
    else if (flag === "--model") model = value;
    else if (flag === "--parent-session") parentSessionId = value;
    else if (flag === "--origin") origin = value;
    else if (flag === "--input-tokens") tokenTotals.inputTokens = parseNonNegativeInteger(value, flag);
    else if (flag === "--output-tokens") tokenTotals.outputTokens = parseNonNegativeInteger(value, flag);
    else if (flag === "--cache-creation-input-tokens") tokenTotals.cacheCreationInputTokens = parseNonNegativeInteger(value, flag);
    else if (flag === "--cache-read-input-tokens") tokenTotals.cacheReadInputTokens = parseNonNegativeInteger(value, flag);
    else if (flag === "--total-tokens") tokenTotals.totalTokens = parseNonNegativeInteger(value, flag);
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (!id || !transcriptPath || !tool) throw new Error(sessionRegisterUsage());
  if (tool !== "claude" && tool !== "codex") throw new Error("Session tool must be claude or codex");
  if (origin !== undefined && !isSessionOrigin(origin)) {
    throw new Error("Session origin must be root, subagent, or spawned");
  }

  return { id, transcriptPath, tool, model, parentSessionId, origin, tokenTotals };
}

export function sessionSetParentUsage(): string {
  return "Usage: trace session set-parent <child-session-id> --parent <parent-session-id> [--origin <origin>] [--tool <tool>] [--transcript <path>]";
}

export function parseSessionSetParentArgs(args: string[]): SetSessionParentInput {
  const id = args[0];
  if (!id || looksLikeFlag(id)) throw new Error(sessionSetParentUsage());

  let parentSessionId: string | undefined;
  let origin: string = "spawned";
  let tool: string | undefined;
  let transcriptPath: string | undefined;

  let index = 1;
  while (index < args.length) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) throw new Error(sessionSetParentUsage());

    if (flag === "--parent") {
      parentSessionId = value;
      index += 2;
    } else if (flag === "--origin") {
      origin = value;
      index += 2;
    } else if (flag === "--tool") {
      tool = value;
      index += 2;
    } else if (flag === "--transcript") {
      transcriptPath = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!parentSessionId) throw new Error(sessionSetParentUsage());
  if (!isSessionOrigin(origin)) {
    throw new Error("Session origin must be root, subagent, or spawned");
  }
  if (tool !== undefined && tool !== "claude" && tool !== "codex") {
    throw new Error("Session tool must be claude or codex");
  }

  return {
    id,
    parentSessionId,
    origin,
    ...(tool !== undefined ? { tool } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  };
}

export function isSessionOrigin(value: string): value is SessionOrigin {
  return value === "root" || value === "subagent" || value === "spawned";
}

export function sessionActiveTaskUsage(): string {
  return "Usage: trace session active-task --id <session-id> [--project <dir>]";
}

export function parseSessionActiveTaskArgs(args: string[]): { id: string; project?: string } {
  let id: string | undefined;
  let project: string | undefined;

  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--id") {
      const value = args[index + 1];
      if (!value) throw new Error(sessionActiveTaskUsage());
      id = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(sessionActiveTaskUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!id) throw new Error(sessionActiveTaskUsage());
  return { id, project };
}

export function parseSessionTailLimit(args: string[]): number | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--limit") throw new Error("Session tail accepts --limit <count>");
  return parseNonNegativeInteger(args[1] ?? "", "--limit");
}

export function codexScanUsage(): string {
  return "Codex scan accepts --codex-home <path>";
}

export function parseCodexScanArgs(args: string[], env: Env): string {
  let codexHome = env.CODEX_HOME;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) throw new Error(codexScanUsage());
    if (flag === "--codex-home") codexHome = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (codexHome) return codexHome;
  if (!env.HOME) throw new Error("Codex scan requires --codex-home when HOME is not set");
  return `${env.HOME}/.codex`;
}

export function claudeScanUsage(): string {
  return "Claude scan accepts --projects-root <path>";
}

export function parseClaudeScanArgs(args: string[], env: Env): string {
  let projectsRoot: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value) throw new Error(claudeScanUsage());
    if (flag === "--projects-root") projectsRoot = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (projectsRoot) return projectsRoot;
  if (!env.HOME) throw new Error("Claude scan requires --projects-root when HOME is not set");
  return `${env.HOME}/.claude/projects`;
}

export function skillWorkOnTaskUsage(): string {
  return "Usage: trace skill work-on-task <title> [--id <id>] [--transcript <path>] [--tool <claude|codex|cursor>] [--model <name>] [--description <text>] [--project <dir>]";
}

export function skillReEnterUsage(): string {
  return "Usage: trace skill re-enter <ref>";
}

export function skillDocsDirUsage(): string {
  return "Usage: trace skill docs-dir [--id <session>] [--project <dir>]";
}

export function recallCandidatesUsage(): string {
  return "Usage: trace skill recall-candidates [--project <dir>]";
}

export function parseSkillWorkOnTaskArgs(
  args: string[],
  env: Env,
  cwd: string,
): {
  id: string;
  transcriptPath: string;
  tool: SessionTool;
  model?: string;
  tokenTotals: Partial<TokenTotals>;
  description?: string;
  project?: string;
} {
  let id: string | undefined;
  let transcriptPath: string | undefined;
  let tool: string | undefined;
  let model: string | undefined;
  let description: string | undefined;
  let project: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!flag || !value) {
      throw new Error(
        "Skill work-on-task accepts --id, --transcript, --tool, --model, --description, and --project",
      );
    }

    if (flag === "--id") id = value;
    else if (flag === "--transcript") transcriptPath = value;
    else if (flag === "--tool") tool = value;
    else if (flag === "--model") model = value;
    else if (flag === "--description") description = value;
    else if (flag === "--project") project = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  let toolOverride: SessionTool | undefined;
  if (tool === undefined) {
    toolOverride = undefined;
  } else if (tool === "claude" || tool === "codex" || tool === "cursor") {
    toolOverride = tool;
  } else {
    throw new Error("Session tool must be claude, codex, or cursor");
  }

  const identity = inferSessionIdentity(env, {
    tool: toolOverride,
    id,
    transcriptPath,
    // Cursor exposes no session env var; bind-time capture resolves the current
    // session (focused GUI composer or newest cursor-agent chat) from the
    // directory the skill ran in. Runs only when no claude/codex session env is
    // present (see inferSessionIdentity).
    cwd,
    resolveCursorSession: (dir) => resolveCursorSession(dir),
  });

  if (identity.id === undefined || identity.transcriptPath === undefined) {
    throw new Error(
      "Skill work-on-task requires --id or a current session env var",
    );
  }

  return {
    id: identity.id,
    transcriptPath: identity.transcriptPath,
    tool: identity.tool,
    model,
    tokenTotals: {},
    description,
    project,
  };
}

export function parseRecallCandidatesArgs(args: string[]): string | undefined {
  let project: string | undefined;

  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(recallCandidatesUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  return project;
}

export function parseSkillDocsDirArgs(args: string[]): { id?: string; project?: string } {
  let id: string | undefined;
  let project: string | undefined;

  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--id") {
      const value = args[index + 1];
      if (!value) throw new Error(skillDocsDirUsage());
      id = value;
      index += 2;
    } else if (flag === "--project") {
      const value = args[index + 1];
      if (!value) throw new Error(skillDocsDirUsage());
      project = value;
      index += 2;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  return { id, project };
}
