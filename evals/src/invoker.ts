import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  assertNoTracePlugin(configDir);
  return configDir;
}

/**
 * Fail loudly when a trace plugin is installed or enabled in the sandbox.
 *
 * The eval is meant to route against the fixture's *project* skills under
 * `evals/fixture/.claude/skills/`. If the trace plugin is also present in the
 * config dir, its (possibly stale) skills get exercised instead — and the run
 * silently scores routing against the wrong source. So treat a present plugin
 * as a hard setup error rather than letting it quietly change what's tested.
 */
function assertNoTracePlugin(configDir: string): void {
  const offenders: string[] = [];

  const installedPath = join(configDir, "plugins", "installed_plugins.json");
  if (existsSync(installedPath)) {
    try {
      const installed = JSON.parse(readFileSync(installedPath, "utf8"));
      for (const name of Object.keys(installed?.plugins ?? {})) {
        if (name.toLowerCase().includes("trace")) offenders.push(`installed: ${name}`);
      }
    } catch {
      // Unparseable file is not this guard's concern; ignore.
    }
  }

  const settingsPath = join(configDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      for (const [name, enabled] of Object.entries(settings?.enabledPlugins ?? {})) {
        if (enabled && name.toLowerCase().includes("trace")) offenders.push(`enabled: ${name}`);
      }
    } catch {
      // Unparseable file is not this guard's concern; ignore.
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `CLAUDE_CONFIG_DIR=${configDir} has a trace plugin present (${offenders.join(", ")}).\n` +
        "The eval must route against the fixture's project skills, not an installed plugin.\n" +
        "Clean the sandbox:\n" +
        `  CLAUDE_CONFIG_DIR=${configDir} claude plugin uninstall trace@trace\n` +
        `  CLAUDE_CONFIG_DIR=${configDir} claude plugin marketplace remove trace`,
    );
  }
}

export interface InvokeResult {
  /** Fired skill names, in order. The first is the routing decision. */
  firedSkills: string[];
  /** Raw stream for diagnostics. */
  raw: string;
}

/**
 * Model the eval drives `claude -p` with. Routing is a cheap classification
 * task, so default to Haiku to keep the report fast and inexpensive; override
 * with EVAL_MODEL (e.g. `EVAL_MODEL=sonnet pnpm eval`) when probing a regression
 * on a specific model.
 */
export const EVAL_MODEL = process.env.EVAL_MODEL ?? "haiku";

/**
 * Deep module: an utterance in, the set of fired skill names out. Hides all the
 * subprocess and stream-parsing detail behind one call.
 *
 * Shells out to `claude -p` with the verified flag set:
 *   --model <EVAL_MODEL>                    (cheap model — Haiku — by default)
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
        "--model",
        EVAL_MODEL,
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
