import {
  readConfigFile,
  resolveDatabasePath,
  updateConfigFile,
} from "@trace/core";
import { failure, isHelpFlag, success, type CommandResult, type Env } from "./seam.ts";

type ConfigCommandContext = { env: Env };

/**
 * The user-settable keys in `config.json`, mapped from their CLI spelling.
 * Adding a key means extending this table plus `TraceConfigFile` in core.
 */
const CONFIG_KEYS = {
  "server-url": "serverUrl",
} as const;

type ConfigKey = keyof typeof CONFIG_KEYS;

function knownKeys(): string {
  return Object.keys(CONFIG_KEYS).join("|");
}

function configUsage(verb: "get" | "set" | "unset"): string {
  const value = verb === "set" ? " <value>" : "";
  return `Usage: trace config ${verb} <${knownKeys()}>${value}`;
}

function parseKey(
  raw: string | undefined,
  verb: "get" | "set" | "unset",
): ConfigKey | CommandResult {
  if (raw === undefined || isHelpFlag(raw)) return success(`${configUsage(verb)}\n`);
  if (!(raw in CONFIG_KEYS)) {
    return failure(`Unknown config key "${raw}" (known keys: ${knownKeys()})`);
  }
  return raw as ConfigKey;
}

export function configGetOperation(
  rawArgs: string[],
  ctx: ConfigCommandContext,
): CommandResult {
  const key = parseKey(rawArgs[0], "get");
  if (typeof key !== "string") return key;
  if (rawArgs.length !== 1) return failure(configUsage("get"));

  const value = readConfigFile(resolveDatabasePath(ctx.env))?.[CONFIG_KEYS[key]];
  if (!value) return failure(`${key} is not set`, 1);
  return success(`${value}\n`);
}

export function configSetOperation(
  rawArgs: string[],
  ctx: ConfigCommandContext,
): CommandResult {
  const key = parseKey(rawArgs[0], "set");
  if (typeof key !== "string") return key;
  const value = rawArgs[1];
  if (!value || rawArgs.length !== 2) return failure(configUsage("set"));

  if (key === "server-url") {
    const invalid = validateServerUrl(value);
    if (invalid) return invalid;
  }

  updateConfigFile(resolveDatabasePath(ctx.env), {
    [CONFIG_KEYS[key]]: value.replace(/\/+$/, ""),
  });
  return success(`${key} set\n`);
}

export function configUnsetOperation(
  rawArgs: string[],
  ctx: ConfigCommandContext,
): CommandResult {
  const key = parseKey(rawArgs[0], "unset");
  if (typeof key !== "string") return key;
  if (rawArgs.length !== 1) return failure(configUsage("unset"));

  updateConfigFile(resolveDatabasePath(ctx.env), {
    [CONFIG_KEYS[key]]: undefined,
  });
  return success(`${key} unset\n`);
}

function validateServerUrl(value: string): CommandResult | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return failure(`"${value}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return failure("server-url must be an http:// or https:// URL");
  }
  return null;
}
