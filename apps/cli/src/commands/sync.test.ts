import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { openTraceStore } from "@trace/core";
import { runSyncCommand } from "./sync.ts";

test("sync exits with a login hint without making a network call", async () => {
  const home = mkdtempSync(join(tmpdir(), "trace-sync-cli-"));
  const fetch = vi.fn<typeof globalThis.fetch>();
  const result = await runSyncCommand({ HOME: home }, { fetch });
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
  const store = openTraceStore(databasePath);
  store.createTask("Synced task");
  store.close();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
    if (String(input).endsWith("/blobs/missing")) return Response.json([]);
    if (String(input).endsWith("/docs/push")) return Response.json({ accepted: 0, uploaded: 0 });
    if (String(input).endsWith("/docs/manifests")) return Response.json([]);
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
});
