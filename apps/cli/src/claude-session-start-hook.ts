#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeSessionStartHook } from "./claude-session-start-hook-runner.ts";

export { runClaudeSessionStartHook };

const invokedPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
const isHookEntry =
  basename(modulePath) === "claude-session-start-hook.ts" ||
  basename(modulePath) === "claude-session-start-hook.js";
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
  const result = runClaudeSessionStartHook(readFileSync(0, "utf8"));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
