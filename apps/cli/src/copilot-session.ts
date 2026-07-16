import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "./commands/seam.ts";

export type CopilotSessionResolverOptions = {
  ancestorPids?: readonly number[];
  isPidAlive?: (pid: number) => boolean;
};

type ResolvedCopilotSession = { id: string; transcriptPath: string };

const lockName = /^inuse\.(\d+)\.lock$/;

// Copilot sessions leave `inuse.<pid>.lock` in their session-state directory.
// A command spawned by Copilot inherits that process as an ancestor, which is
// the only stable identity channel the CLI exposes to shell tools.
export function resolveCopilotSession(
  env: Env,
  options: CopilotSessionResolverOptions = {},
): ResolvedCopilotSession | null {
  const sessionState = join(
    env.COPILOT_HOME?.trim() || join(homedir(), ".copilot"),
    "session-state",
  );
  const ancestorPids = options.ancestorPids ?? resolveAncestorPids();
  const isPidAlive = options.isPidAlive ?? pidIsAlive;

  for (const pid of ancestorPids) {
    if (!isPidAlive(pid)) continue;
    const session = sessionForPid(sessionState, pid);
    if (session) return session;
  }

  return null;
}

function sessionForPid(
  sessionState: string,
  pid: number,
): ResolvedCopilotSession | null {
  let sessionIds: string[];
  try {
    sessionIds = readdirSync(sessionState);
  } catch {
    return null;
  }

  for (const id of sessionIds) {
    const directory = join(sessionState, id);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    if (!names.some((name) => lockName.test(name) && name === `inuse.${pid}.lock`)) {
      continue;
    }

    const transcriptPath = join(directory, "events.jsonl");
    if (existsSync(transcriptPath)) return { id, transcriptPath };
  }

  return null;
}

function resolveAncestorPids(): number[] {
  const ancestors: number[] = [];
  const seen = new Set<number>();
  let pid = process.pid;

  while (pid > 1 && !seen.has(pid)) {
    ancestors.push(pid);
    seen.add(pid);
    try {
      const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      const parent = Number.parseInt(output, 10);
      if (!Number.isSafeInteger(parent) || parent < 1) break;
      pid = parent;
    } catch {
      break;
    }
  }

  return ancestors;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
