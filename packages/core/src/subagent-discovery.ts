import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseClaudeCodeTranscriptFile } from "./claude-code-adapter.ts";
import type { Session, TaskStore } from "./types.ts";

export type DiscoverClaudeCodeSubagentSessionsInput = {
  store: TaskStore;
  parentSessionId: string;
  subagentsDir?: string;
};

export function discoverClaudeCodeSubagentSessions(
  input: DiscoverClaudeCodeSubagentSessionsInput,
): Session[] {
  const parent = input.store.getSession(input.parentSessionId);
  if (!parent) {
    throw new Error(`Parent session not found: ${input.parentSessionId}`);
  }

  const subagentsDir = input.subagentsDir ?? defaultSubagentsDir(parent);
  if (!existsSync(subagentsDir)) {
    return [];
  }

  const subagentTypeByAgentId = readSubagentTypes(parent.transcriptPath);

  return readdirSync(subagentsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("agent-") &&
        entry.name.endsWith(".jsonl"),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const transcriptPath = join(subagentsDir, entry.name);
      const agentId = agentIdFromFilename(entry.name);
      const parsed = parseClaudeCodeTranscriptFile(transcriptPath);
      const registered = input.store.registerSession({
        id: `${parent.id}:subagent:${agentId}`,
        transcriptPath,
        tool: "claude",
        model: parsed.model,
        parentSessionId: parent.id,
        origin: "subagent",
        subagentType:
          subagentTypeByAgentId.get(agentId) ??
          readMetaAgentType(transcriptPath),
        agentId,
        tokenTotals: parsed.tokenTotals,
      });

      return parent.taskId
        ? input.store.assignSession(registered.id, parent.taskId)
        : registered;
    });
}

function defaultSubagentsDir(parent: Session): string {
  const transcriptDir = dirname(parent.transcriptPath);
  if (basename(transcriptDir) === parent.id) {
    return join(transcriptDir, "subagents");
  }

  return join(transcriptDir, parent.id, "subagents");
}

function agentIdFromFilename(filename: string): string {
  return basename(filename, ".jsonl").replace(/^agent-/, "");
}

function readSubagentTypes(transcriptPath: string): Map<string, string> {
  const subagentTypeByToolUseId = new Map<string, string>();
  const subagentTypeByAgentId = new Map<string, string>();

  if (!existsSync(transcriptPath)) {
    return subagentTypeByAgentId;
  }

  for (const line of readFileSync(transcriptPath, "utf8").split(/\r?\n/)) {
    const event = parseJsonObject(line);
    if (!event) continue;

    for (const toolUse of toolUseEvents(event)) {
      const subagentType = stringValue(toolUse.input, [
        "subagent_type",
        "subagentType",
        "agent_type",
        "agentType",
      ]);
      if (subagentType) {
        subagentTypeByToolUseId.set(toolUse.id, subagentType);
      }
    }

    for (const toolResult of toolResultEvents(event)) {
      const subagentType = subagentTypeByToolUseId.get(toolResult.toolUseId);
      const agentId = toolResultAgentId(event, toolResult);
      if (subagentType && agentId) {
        subagentTypeByAgentId.set(agentId, subagentType);
      }
    }
  }

  return subagentTypeByAgentId;
}

function readMetaAgentType(transcriptPath: string): string | null {
  const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) {
    return null;
  }

  const meta = parseJsonObject(readFileSync(metaPath, "utf8"));
  return meta ? stringValue(meta, ["agentType", "subagent_type"]) : null;
}

type JsonObject = Record<string, unknown>;

type ToolUseEvent = {
  id: string;
  input: JsonObject;
};

type ToolResultEvent = {
  toolUseId: string;
  content: unknown;
};

function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolUseEvents(event: JsonObject): ToolUseEvent[] {
  return messageContent(event)
    .filter(
      (content): content is JsonObject =>
        isObject(content) &&
        content.type === "tool_use" &&
        (content.name === "Task" || content.name === "Agent") &&
        typeof content.id === "string" &&
        isObject(content.input),
    )
    .map((content) => ({
      id: content.id as string,
      input: content.input as JsonObject,
    }));
}

function toolResultEvents(event: JsonObject): ToolResultEvent[] {
  return messageContent(event)
    .filter(
      (content): content is JsonObject =>
        isObject(content) &&
        content.type === "tool_result" &&
        typeof content.tool_use_id === "string",
    )
    .map((content) => ({
      toolUseId: content.tool_use_id as string,
      content: content.content,
    }));
}

function toolResultAgentId(
  event: JsonObject,
  toolResult: ToolResultEvent,
): string | null {
  const direct = isObject(event.toolUseResult)
    ? stringValue(event.toolUseResult, ["agentId", "agent_id"])
    : null;
  if (direct) {
    return direct;
  }

  return agentIdFromText(toolResult.content);
}

function agentIdFromText(content: unknown): string | null {
  const texts = Array.isArray(content)
    ? content.flatMap((item) =>
        isObject(item) && typeof item.text === "string" ? [item.text] : [],
      )
    : typeof content === "string"
      ? [content]
      : [];

  for (const text of texts) {
    const match = /agentId:\s*([A-Za-z0-9_-]+)/.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function messageContent(event: JsonObject): unknown[] {
  const message = isObject(event.message) ? event.message : event;
  return Array.isArray(message.content) ? message.content : [];
}

function stringValue(object: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
