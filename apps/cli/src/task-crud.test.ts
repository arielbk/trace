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
