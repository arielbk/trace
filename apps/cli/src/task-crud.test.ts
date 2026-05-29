import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));

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
      [traceBin, "skill", "re-enter", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(context).toMatch(/docs:/);
    expect(context).toContain(`- ${docPath}`);
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
        taskId,
        "--id",
        "codex-session-1",
        "--transcript",
        "/tmp/codex-session-1.jsonl",
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );
    expect(bound).toBe(`codex-session-1\tcodex\t/tmp/codex-session-1.jsonl\n`);

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
      [traceBin, "skill", "re-enter", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(context).toMatch(new RegExp(`task: ${taskId}`));
    expect(context).toMatch(/docs:\n- \/tmp\/spec\.md/);
    expect(context).toMatch(
      /sessions:\n- codex-session-1\tcodex\t\/tmp\/codex-session-1\.jsonl/,
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
        taskId,
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
