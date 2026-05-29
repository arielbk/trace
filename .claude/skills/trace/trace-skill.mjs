#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const [verb, title, ...rest] = process.argv.slice(2);

if (!verb || !title) {
  fail(
    "Usage: trace-skill.mjs <work-on-task|re-enter> <task-title> [session flags]",
  );
}

if (verb !== "work-on-task" && verb !== "re-enter") {
  fail(`Unknown verb: ${verb}`);
}

const taskId = resolveTaskId(title, { create: verb === "work-on-task" });
const result =
  verb === "work-on-task"
    ? runTrace(["skill", "work-on-task", taskId, ...rest])
    : runTrace(["skill", "re-enter", taskId]);

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;

function resolveTaskId(taskTitle, options) {
  const listed = runTrace(["task", "list"]);
  if (listed.status !== 0) {
    process.stdout.write(listed.stdout);
    process.stderr.write(listed.stderr);
    process.exit(listed.status ?? 1);
  }

  for (const line of listed.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [id, listedTitle] = line.split("\t");
    if (listedTitle === taskTitle) return id;
  }

  if (!options.create) {
    fail(`Task not found: ${taskTitle}`, 1);
  }

  const created = runTrace(["task", "create", taskTitle]);
  if (created.status !== 0) {
    process.stdout.write(created.stdout);
    process.stderr.write(created.stderr);
    process.exit(created.status ?? 1);
  }

  return created.stdout.trim();
}

function runTrace(args) {
  const [command, ...commandArgs] = traceCommand();
  return spawnSync(command, [...commandArgs, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

function traceCommand() {
  const configured = process.env.TRACE_BIN?.trim();
  if (!configured) return ["trace"];

  return configured.split(/\s+/);
}

function fail(message, exitCode = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}
