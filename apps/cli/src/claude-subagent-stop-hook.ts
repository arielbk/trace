#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeSubagentStopHook } from "./claude-subagent-stop-hook-runner.ts";

export { runClaudeSubagentStopHook };

const invokedPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
const isHookEntry =
  basename(modulePath) === "claude-subagent-stop-hook.ts" ||
  basename(modulePath) === "claude-subagent-stop-hook.js";
const isDirectRun =
  invokedPath !== undefined &&
  isHookEntry &&
  safeRealpath(invokedPath) === modulePath;

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (isDirectRun) {
  const result = runClaudeSubagentStopHook(readFileSync(0, "utf8"));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
