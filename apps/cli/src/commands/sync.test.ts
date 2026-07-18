import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { openTraceStore, readSyncStatus } from "@trace/core";
import { runSyncCommand, triggerBackgroundSync } from "./sync.ts";

test("background sync detaches immediately and logged-out triggers spawn nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-sync-trigger-"));
  const child = { on: vi.fn(), unref: vi.fn() };
  const spawn = vi.fn(() => child);

  triggerBackgroundSync({ HOME: home }, { spawn });
  expect(spawn).not.toHaveBeenCalled();

  mkdirSync(join(home, ".trace"));
  writeFileSync(join(home, ".trace", "auth.json"), JSON.stringify({ accessToken: "secret" }));
  writeFileSync(
    join(home, ".trace", "key.json"),
    JSON.stringify({ masterKey: "12".repeat(32) }),
  );
  triggerBackgroundSync({ HOME: home }, { spawn, executable: "/trace/cli.js" });

  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    ["/trace/cli.js", "sync"],
    expect.objectContaining({ detached: true, stdio: "ignore" }),
  );
  expect(child.unref).toHaveBeenCalled();
});

test("sync no-ops with a config hint when no server is configured", async () => {
  const home = mkdtempSync(join(tmpdir(), "trace-sync-cli-"));
  const fetch = vi.fn<typeof globalThis.fetch>();
  const result = await runSyncCommand({ HOME: home }, { fetch });
  expect(result).toEqual({
    exitCode: 0,
    stdout: "No sync server configured. Run trace config set server-url <url>.\n",
    stderr: "",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("sync exits with a login hint without making a network call", async () => {
  const home = mkdtempSync(join(tmpdir(), "trace-sync-cli-"));
  const fetch = vi.fn<typeof globalThis.fetch>();
  const result = await runSyncCommand(
    { HOME: home, TRACE_SERVER_URL: "https://sync.test" },
    { fetch },
  );
  expect(result).toEqual({
    exitCode: 0,
    stdout: "Not logged in. Run trace login.\n",
    stderr: "",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("sync sends local rows with the bearer token and prints a summary", async () => {
  const home = mkdtempSync(join(tmpdir(), "trace-sync-cli-"));
  const databasePath = join(home, "trace.db");
  mkdirSync(join(home, ".trace"));
  writeFileSync(join(home, ".trace", "auth.json"), JSON.stringify({ accessToken: "secret" }));
  writeFileSync(
    join(home, ".trace", "key.json"),
    JSON.stringify({ masterKey: "12".repeat(32) }),
  );
  const store = openTraceStore(databasePath);
  store.createTask("Synced task");
  store.close();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
    if (String(input).endsWith("/blobs/missing")) return Response.json([]);
    if (String(input).endsWith("/docs/push")) return Response.json({ accepted: 0, uploaded: 0 });
    if (String(input).endsWith("/docs/manifests")) return Response.json({ manifests: [], wrappedKeys: [] });
    return String(input).endsWith("/sync/push")
      ? Response.json({ accepted: 1 })
      : Response.json({ tasks: [], sessions: [] });
  });

  const result = await runSyncCommand(
    { HOME: home, TRACE_DB: databasePath, TRACE_SERVER_URL: "https://sync.test" },
    { fetch },
  );
  expect(result).toEqual({
    exitCode: 0,
    stdout: "Sync complete: 1 pushed, 0 pulled.\n",
    stderr: "",
  });
  expect(fetch).toHaveBeenCalledTimes(5);

  // The board can read the last-sync outcome from beside the database.
  const status = readSyncStatus(databasePath);
  expect(status.state).toBe("synced");
  if (status.state === "synced") {
    expect(Number.isNaN(Date.parse(status.lastSyncedAt))).toBe(false);
  }
});

test("a failed sync records the error for the board without throwing", async () => {
  const home = mkdtempSync(join(tmpdir(), "trace-sync-cli-"));
  const databasePath = join(home, "trace.db");
  mkdirSync(join(home, ".trace"));
  writeFileSync(join(home, ".trace", "auth.json"), JSON.stringify({ accessToken: "secret" }));
  writeFileSync(
    join(home, ".trace", "key.json"),
    JSON.stringify({ masterKey: "12".repeat(32) }),
  );
  openTraceStore(databasePath).close();
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({}, { status: 500 }),
  );

  const result = await runSyncCommand(
    { HOME: home, TRACE_DB: databasePath, TRACE_SERVER_URL: "https://sync.test" },
    { fetch },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Sync failed");

  const status = readSyncStatus(databasePath);
  expect(status.state).toBe("failed");
  if (status.state === "failed") {
    expect(status.lastError).toContain("server returned 500");
  }
});
