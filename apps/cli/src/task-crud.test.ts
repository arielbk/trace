import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const traceBin = resolve("apps/cli/src/trace.ts");

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

    assert.match(id, /^[0-9a-f-]{36}$/);

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", id],
      {
        encoding: "utf8",
        env,
      },
    );
    assert.match(shown, new RegExp(`id: ${id}`));
    assert.match(shown, /title: checkout/);

    const listed = execFileSync(process.execPath, [traceBin, "task", "list"], {
      encoding: "utf8",
      env,
    });
    assert.equal(listed, `${id}\tcheckout\n`);
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
    assert.equal(unassigned, "session-1\tcodex\t/tmp/session-1.jsonl\n");

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
    assert.match(shown, /sessions:/);
    assert.match(shown, /- session-1\tcodex\t\/tmp\/session-1\.jsonl/);

    const nowUnassigned = execFileSync(
      process.execPath,
      [traceBin, "session", "list", "--unassigned"],
      {
        encoding: "utf8",
        env,
      },
    );
    assert.equal(nowUnassigned, "");
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
    assert.equal(added, `${taskId}\t/tmp/spec.md\n`);

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    assert.match(shown, /docs:/);
    assert.match(shown, /- \/tmp\/spec\.md/);
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
        session?: { id: string };
        doc?: { path: string };
      }>;
      tokenTotals: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    };

    assert.equal(timeline.task.id, taskId);
    assert.equal(timeline.task.title, "checkout");
    assert.deepEqual(
      timeline.items.map((item) =>
        item.type === "session" ? item.session?.id : item.doc?.path,
      ),
      ["session-1", "/tmp/spec.md"],
    );
    assert.deepEqual(timeline.tokenTotals, {
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
    assert.equal(bound, `codex-session-1\tcodex\t/tmp/codex-session-1.jsonl\n`);

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    assert.match(
      shown,
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
    assert.match(context, new RegExp(`task: ${taskId}`));
    assert.match(context, /docs:\n- \/tmp\/spec\.md/);
    assert.match(
      context,
      /sessions:\n- codex-session-1\tcodex\t\/tmp\/codex-session-1\.jsonl/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
