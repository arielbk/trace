import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { parse } from "./parser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the pinned fixture used as the agent's cwd. */
export const FIXTURE_DIR = resolve(__dirname, "..", "fixture");

/**
 * Resolve and validate the authed clean base (`CLAUDE_CONFIG_DIR`).
 *
 * Documented default: ~/.claude-sandbox — set CLAUDE_CONFIG_DIR explicitly to
 * override. Fails fast when unset, non-existent, or not a logged-in config so
 * the maintainer's real config never silently bleeds in.
 */
export function resolveConfigDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) {
    throw new Error(
      "CLAUDE_CONFIG_DIR is not set.\n" +
        "Set it to a logged-in claude config directory, e.g.:\n" +
        "  CLAUDE_CONFIG_DIR=~/.claude-sandbox pnpm eval",
    );
  }
  if (!existsSync(configDir)) {
    throw new Error(
      `CLAUDE_CONFIG_DIR=${configDir} does not exist.\n` +
        "Create the directory and run 'claude login' in it once to initialize a logged-in config.",
    );
  }
  if (!existsSync(join(configDir, ".claude.json"))) {
    throw new Error(
      `CLAUDE_CONFIG_DIR=${configDir} is not a logged-in claude config (no .claude.json found).\n` +
        "Run 'claude' in that directory once to log in and initialize it.",
    );
  }
  return configDir;
}

export interface InvokeResult {
  /** Fired skill names, in order. The first is the routing decision. */
  firedSkills: string[];
  /** Raw stream for diagnostics. */
  raw: string;
}

/**
 * Deep module: an utterance in, the set of fired skill names out. Hides all the
 * subprocess and stream-parsing detail behind one call.
 *
 * Shells out to `claude -p` with the verified flag set:
 *   --output-format stream-json --verbose  (stream-json needs --verbose to emit
 *                                            per-message tool-use events)
 *   --allowedTools Skill                    (scope-allow only skill invocation)
 *   --max-turns 3                           (bound the run)
 * cwd  = fixture dir   (trace + decoy skills are discovered as project skills)
 * env  CLAUDE_CONFIG_DIR = authed clean base
 * stdin < /dev/null    (otherwise the CLI stalls ~3s waiting on stdin)
 */
export function invoke(utterance: string): Promise<InvokeResult> {
  const configDir = resolveConfigDir();

  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        utterance,
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        "Skill",
        "--max-turns",
        "3",
      ],
      {
        cwd: FIXTURE_DIR,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && stdout.trim() === "") {
        reject(
          new Error(
            `claude -p exited ${code} with no output.\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolvePromise({ firedSkills: parse(stdout), raw: stdout });
    });
  });
}
