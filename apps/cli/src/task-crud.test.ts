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
    const id = execFileSync(process.execPath, [traceBin, "task", "create", "checkout"], {
      encoding: "utf8",
      env,
    }).trim();

    assert.match(id, /^[0-9a-f-]{36}$/);

    const shown = execFileSync(process.execPath, [traceBin, "task", "show", id], {
      encoding: "utf8",
      env,
    });
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
    const taskId = execFileSync(process.execPath, [traceBin, "task", "create", "checkout"], {
      encoding: "utf8",
      env,
    }).trim();

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

    const unassigned = execFileSync(process.execPath, [traceBin, "session", "list", "--unassigned"], {
      encoding: "utf8",
      env,
    });
    assert.equal(unassigned, "session-1\tcodex\t/tmp/session-1.jsonl\n");

    execFileSync(process.execPath, [traceBin, "session", "assign", "session-1", taskId], {
      encoding: "utf8",
      env,
    });

    const shown = execFileSync(process.execPath, [traceBin, "task", "show", taskId], {
      encoding: "utf8",
      env,
    });
    assert.match(shown, /sessions:/);
    assert.match(shown, /- session-1\tcodex\t\/tmp\/session-1\.jsonl/);

    const nowUnassigned = execFileSync(process.execPath, [traceBin, "session", "list", "--unassigned"], {
      encoding: "utf8",
      env,
    });
    assert.equal(nowUnassigned, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
