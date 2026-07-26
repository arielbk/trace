import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { openTraceStore, readSyncStatus, updateConfigFile } from "@trace/core";
import {
  AUTOMATIC_SYNC_ENV_VAR,
  requestAutomaticSync,
  runSyncCommand,
} from "./sync.ts";

/** A HOME whose `.trace` holds a bearer token and document key, i.e. logged in. */
function loggedInHome(prefix = "trace-sync-cli-"): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, ".trace"));
  writeFileSync(
    join(home, ".trace", "auth.json"),
    JSON.stringify({ accessToken: "secret" }),
  );
  writeFileSync(
    join(home, ".trace", "key.json"),
    JSON.stringify({ masterKey: "12".repeat(32) }),
  );
  return home;
}

/** Turn AutoSync off for the database this HOME resolves to. */
function disableAutoSync(home: string): void {
  updateConfigFile(join(home, ".trace", "trace.db"), { autoSync: false });
}

test("background sync detaches immediately and logged-out triggers spawn nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-sync-trigger-"));
  const child = { on: vi.fn(), unref: vi.fn() };
  const spawn = vi.fn(() => child);

  requestAutomaticSync({ HOME: home }, { spawn });
  expect(spawn).not.toHaveBeenCalled();

  mkdirSync(join(home, ".trace"));
  writeFileSync(join(home, ".trace", "auth.json"), JSON.stringify({ accessToken: "secret" }));
  writeFileSync(
    join(home, ".trace", "key.json"),
    JSON.stringify({ masterKey: "12".repeat(32) }),
  );
  requestAutomaticSync({ HOME: home }, { spawn, executable: "/trace/cli.js" });

  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    ["/trace/cli.js", "sync"],
    expect.objectContaining({ detached: true, stdio: "ignore" }),
  );
  expect(child.unref).toHaveBeenCalled();
});

test("an automatic sync request marks the spawned process as automatic", () => {
  const home = loggedInHome("trace-sync-marker-");
  const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));

  requestAutomaticSync({ HOME: home }, { spawn, executable: "/trace/cli.js" });

  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    ["/trace/cli.js", "sync"],
    expect.objectContaining({
      env: expect.objectContaining({ [AUTOMATIC_SYNC_ENV_VAR]: "1" }),
    }),
  );
});

test("an automatic sync request spawns nothing while auto-sync is disabled", () => {
  const home = loggedInHome("trace-sync-policy-");
  const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));

  requestAutomaticSync({ HOME: home }, { spawn, executable: "/trace/cli.js" });
  expect(spawn).toHaveBeenCalledOnce();

  disableAutoSync(home);
  spawn.mockClear();
  requestAutomaticSync({ HOME: home }, { spawn, executable: "/trace/cli.js" });
  expect(spawn).not.toHaveBeenCalled();
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

test("an automatic sync job queued before the opt-out never reaches the network", async () => {
  const home = loggedInHome("trace-sync-boundary-");
  const databasePath = join(home, ".trace", "trace.db");
  openTraceStore(databasePath).close();
  const fetch = vi.fn<typeof globalThis.fetch>();

  // The scheduling check passed a moment ago; the user opts out while the
  // spawned process is still starting up.
  disableAutoSync(home);

  const result = await runSyncCommand(
    {
      HOME: home,
      TRACE_SERVER_URL: "https://sync.test",
      [AUTOMATIC_SYNC_ENV_VAR]: "1",
    },
    { fetch },
  );

  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(fetch).not.toHaveBeenCalled();
  // A refused automatic run is not a sync outcome, so it must not overwrite
  // whatever the board is currently showing.
  expect(readSyncStatus(databasePath).state).toBe("logged-out");
});

test("explicit sync still synchronizes while auto-sync is disabled", async () => {
  const home = loggedInHome("trace-sync-explicit-");
  const databasePath = join(home, ".trace", "trace.db");
  const store = openTraceStore(databasePath);
  store.createTask("Manually synced task");
  store.close();
  disableAutoSync(home);

  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (String(input).endsWith("/blobs/missing")) return Response.json([]);
    if (String(input).endsWith("/docs/push")) return Response.json({ accepted: 0, uploaded: 0 });
    if (String(input).endsWith("/docs/manifests")) return Response.json({ manifests: [], wrappedKeys: [] });
    return String(input).endsWith("/sync/push")
      ? Response.json({ accepted: 1 })
      : Response.json({ tasks: [], sessions: [] });
  });

  const result = await runSyncCommand(
    { HOME: home, TRACE_SERVER_URL: "https://sync.test" },
    { fetch },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Sync complete: 1 pushed");
  expect(readSyncStatus(databasePath).state).toBe("synced");
});
