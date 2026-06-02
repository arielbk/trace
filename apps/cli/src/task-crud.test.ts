import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

test("init writes the Claude SessionStart hook into settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-init-"));
  const env = {
    ...process.env,
    HOME: dir,
    TRACE_DB: join(dir, "trace.sqlite"),
  };

  try {
    const output = execFileSync(process.execPath, [traceBin, "init"], {
      encoding: "utf8",
      env,
    });

    expect(output).toContain("registered Claude SessionStart hook");
    expect(output).toContain("trace skill: found");
    expect(output).toContain("manual: run pnpm link --global");

    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks?: {
        SessionStart?: Array<{
          hooks?: Array<{ type?: string; command?: string }>;
        }>;
      };
    };
    expect(settings.hooks?.SessionStart).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `${process.execPath} ${fileURLToPath(
              new URL("./claude-session-start-hook.ts", import.meta.url),
            )}`,
          },
        ],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init preserves existing Claude settings and does not duplicate the hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-init-"));
  const settingsPath = join(dir, ".claude", "settings.json");
  const env = {
    ...process.env,
    HOME: dir,
    TRACE_DB: join(dir, "trace.sqlite"),
  };

  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Bash(git status:*)"] },
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
          },
        },
        null,
        2,
      ),
    );

    execFileSync(process.execPath, [traceBin, "init"], {
      encoding: "utf8",
      env,
    });
    const secondOutput = execFileSync(process.execPath, [traceBin, "init"], {
      encoding: "utf8",
      env,
    });

    expect(secondOutput).toContain(
      "Claude SessionStart hook already registered",
    );

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions?: { allow?: string[] };
      hooks?: Record<
        string,
        Array<{ hooks?: Array<{ type?: string; command?: string }> }>
      >;
    };
    expect(settings.permissions?.allow).toEqual(["Bash(git status:*)"]);
    expect(settings.hooks?.Stop).toEqual([
      { hooks: [{ type: "command", command: "echo stop" }] },
    ]);
    expect(settings.hooks?.SessionStart).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create then show round-trips a persisted task", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const id = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", id],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(new RegExp(`id: ${id}`));
    expect(shown).toMatch(/title: checkout/);

    const listed = execFileSync(process.execPath, [traceBin, "task", "list"], {
      encoding: "utf8",
      env,
    });
    expect(listed).toBe(`${id}\tcheckout\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("register then assign session attaches it to task show", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "session-1",
        "--transcript",
        "/tmp/session-1.jsonl",
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );

    const unassigned = execFileSync(
      process.execPath,
      [traceBin, "session", "list", "--unassigned"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(unassigned).toBe("session-1\tcodex\t/tmp/session-1.jsonl\n");

    execFileSync(
      process.execPath,
      [traceBin, "session", "assign", "session-1", taskId],
      {
        encoding: "utf8",
        env,
      },
    );

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(/sessions:/);
    expect(shown).toMatch(/- session-1\tcodex\t\/tmp\/session-1\.jsonl/);

    const nowUnassigned = execFileSync(
      process.execPath,
      [traceBin, "session", "list", "--unassigned"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(nowUnassigned).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session tail prints recent transcript messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-tail-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "session-1.jsonl");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user_message", message: "First" }),
        JSON.stringify({ type: "assistant_message", message: "Second" }),
        JSON.stringify({ type: "user_message", message: "Third" }),
      ].join("\n"),
    );

    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "session-1",
        "--transcript",
        transcriptPath,
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );

    const tail = execFileSync(
      process.execPath,
      [traceBin, "session", "tail", "session-1", "--limit", "2"],
      { encoding: "utf8", env },
    );

    expect(tail).toBe("assistant: Second\nuser: Third\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add-doc then show lists the associated task doc", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    const added = execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", taskId, "/tmp/spec.md"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(added).toBe(`${taskId}\t/tmp/spec.md\n`);

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(/docs:/);
    expect(shown).toMatch(/- \/tmp\/spec\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task show and skill re-enter list docs written under the trace task docs directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();
    const docsDir = join(dir, ".trace", "tasks", taskId, "docs");
    const docPath = join(docsDir, "decision.md");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(docPath, "# Decision\n");

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(/docs:/);
    expect(shown).toContain(`- ${docPath}`);

    const context = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(context).toMatch(/docs:/);
    expect(context).toContain(`- path: ${docPath}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task timeline --json prints the aggregated task timeline", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "session-1",
        "--transcript",
        "/tmp/session-1.jsonl",
        "--tool",
        "codex",
        "--model",
        "gpt-5-codex",
        "--input-tokens",
        "12",
        "--output-tokens",
        "8",
        "--total-tokens",
        "20",
      ],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [traceBin, "session", "assign", "session-1", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", taskId, "/tmp/spec.md"],
      {
        encoding: "utf8",
        env,
      },
    );

    const timeline = JSON.parse(
      execFileSync(
        process.execPath,
        [traceBin, "task", "timeline", taskId, "--json"],
        {
          encoding: "utf8",
          env,
        },
      ),
    ) as {
      task: { id: string; title: string };
      items: Array<{
        type: string;
        session?: { id: string; model: string | null };
        doc?: { path: string };
      }>;
      tokenTotals: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    };

    expect(timeline.task.id).toBe(taskId);
    expect(timeline.task.title).toBe("checkout");
    expect(
      timeline.items.map((item) =>
        item.type === "session" ? item.session?.id : item.doc?.path,
      ),
    ).toEqual(["session-1", "/tmp/spec.md"]);
    expect(timeline.items[0]?.session?.model).toBe("gpt-5-codex");
    expect(timeline.tokenTotals).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 20,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task binds a simulated session and re-enter lists task context", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", taskId, "/tmp/spec.md"],
      {
        encoding: "utf8",
        env,
      },
    );

    const bound = execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "checkout",
        "--id",
        "codex-session-1",
        "--transcript",
        "/tmp/codex-session-1.jsonl",
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );
    expect(bound).toBe(
      [
        `codex-session-1\tcodex\t/tmp/codex-session-1.jsonl`,
        `taskDocsDir: ${join(dir, "tasks", taskId, "docs")}`,
        "",
      ].join("\n"),
    );

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(
      /- codex-session-1\tcodex\t\/tmp\/codex-session-1\.jsonl/,
    );

    const context = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(context).toMatch(new RegExp(`task:\\n  id: ${taskId}`));
    expect(context).toMatch(/docs:\n- path: \/tmp\/spec\.md/);
    expect(context).toMatch(
      /sessions:\n- id: codex-session-1\n {2}tool: codex\n {2}transcript: \/tmp\/codex-session-1\.jsonl\n {2}mostRecent: true/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task infers the live Claude session from CLAUDE_CODE_SESSION_ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-infer-"));
  const databasePath = join(dir, "trace.sqlite");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRACE_DB: databasePath,
    CLAUDE_CODE_SESSION_ID: "live-claude-session",
  };
  // Prove CLAUDE_CODE_SESSION_ID is what's read, not the legacy names.
  delete env.CLAUDE_SESSION_ID;
  delete env.session_id;
  delete env.CODEX_THREAD_ID;

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const bound = execFileSync(
      process.execPath,
      [traceBin, "skill", "work-on-task", "checkout"],
      { encoding: "utf8", env },
    );
    expect(bound).toBe(
      [
        `live-claude-session\tclaude\tclaude:live-claude-session`,
        `taskDocsDir: ${join(dir, "tasks", taskId, "docs")}`,
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill re-enter prints an ordered manifest with empty sections", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-manifest-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const emptyManifest = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      { encoding: "utf8", env },
    );
    expect(emptyManifest).toContain(`task:\n  id: ${taskId}\n`);
    expect(emptyManifest).toContain("docs: []\n");
    expect(emptyManifest).toContain("sessions: []\n");

    const docsDir = join(dir, ".trace", "tasks", taskId, "docs");
    const nativeDocPath = join(docsDir, "decision.md");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(nativeDocPath, "# Decision\n");
    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", taskId, "/tmp/external.md"],
      { encoding: "utf8", env },
    );

    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "older-session",
        "--transcript",
        "/tmp/older.jsonl",
        "--tool",
        "claude",
      ],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [traceBin, "session", "assign", "older-session", taskId],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "newer-session",
        "--transcript",
        "/tmp/newer.jsonl",
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [traceBin, "session", "assign", "newer-session", taskId],
      { encoding: "utf8", env },
    );

    const manifest = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      { encoding: "utf8", env },
    );

    expect(manifest).toContain(`- path: ${nativeDocPath}`);
    expect(manifest).toContain("- path: /tmp/external.md");
    expect(manifest.indexOf("- id: newer-session")).toBeLessThan(
      manifest.indexOf("- id: older-session"),
    );
    expect(manifest).toMatch(
      /- id: newer-session\n {2}tool: codex\n {2}transcript: \/tmp\/newer\.jsonl\n {2}mostRecent: true/,
    );
    expect(manifest).toMatch(
      /- id: older-session\n {2}tool: claude\n {2}transcript: \/tmp\/older\.jsonl\n {2}mostRecent: false/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task --model persists the session model", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-model-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "checkout",
        "--id",
        "claude-session-1",
        "--transcript",
        "/tmp/claude-session-1.jsonl",
        "--tool",
        "claude",
        "--model",
        "claude-opus-4-7",
      ],
      { encoding: "utf8", env },
    );

    const timeline = JSON.parse(
      execFileSync(
        process.execPath,
        [traceBin, "task", "timeline", taskId, "--json"],
        { encoding: "utf8", env },
      ),
    ) as {
      items: Array<{
        type: string;
        session?: { id: string; model: string | null };
      }>;
    };

    expect(timeline.items[0]?.session?.model).toBe("claude-opus-4-7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
