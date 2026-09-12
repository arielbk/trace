import { expect, test } from "vitest";
import type { SyncStatusResponse } from "@trace/core/browser";
import { describeAccount } from "./AccountMenu.tsx";

/**
 * What the account surface says while a second machine is bringing recovered
 * work onto itself. The rule these tests exist to hold is a single one:
 * "ready" is only ever said about a machine that actually has the work and
 * will keep it current. Every other state has to say what is missing.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");
const JUST_NOW = "2026-09-10T11:59:30.000Z";

const headlineOf = (status: SyncStatusResponse): string | undefined =>
  describeAccount(status, NOW).headline;

test("each restore phase is named before readiness is claimed", () => {
  expect(
    headlineOf({
      state: "syncing",
      startedAt: JUST_NOW,
      restore: { phase: "metadata" },
    }),
  ).toBe("Bringing tasks onto this machine…");
  expect(
    headlineOf({
      state: "syncing",
      startedAt: JUST_NOW,
      restore: { phase: "documents" },
    }),
  ).toBe("Bringing documents onto this machine…");
  expect(
    headlineOf({
      state: "synced",
      lastSyncedAt: JUST_NOW,
      restore: { phase: "ready", taskCount: 1 },
    }),
  ).toBe("Work is ready on this machine.");
});

test("an account with nothing in it settles honestly rather than claiming work", () => {
  expect(
    headlineOf({
      state: "synced",
      lastSyncedAt: JUST_NOW,
      restore: { phase: "ready", taskCount: 0 },
    }),
  ).toBe("Ready — no synced tasks in this account yet.");
});

test("a partial recovery keeps its tasks and says the documents are missing", () => {
  const partial = describeAccount(
    {
      state: "synced",
      lastSyncedAt: JUST_NOW,
      restore: { phase: "partial", taskCount: 1 },
    },
    NOW,
  );
  expect(partial.headline).toBe("Some documents are still waiting.");
  expect(partial.detail).toContain("Your available tasks remain usable.");
});

test("paused policy is reported instead of readiness, never instead of a live restore", () => {
  // Nothing in flight: what governs the next run is the useful thing to say,
  // and it stands in front of "ready" — this machine will not stay current.
  const paused = describeAccount(
    {
      state: "synced",
      lastSyncedAt: JUST_NOW,
      autoSync: false,
      restore: { phase: "ready", taskCount: 1 },
    },
    NOW,
  );
  expect(paused.headline).toBe("Sync is paused on this machine.");
  expect(paused.detail).toContain("eqnx config set auto-sync true");

  // But a manual run really is in flight here, and saying "paused" over it
  // would describe the wrong thing entirely.
  expect(
    headlineOf({
      state: "syncing",
      startedAt: JUST_NOW,
      autoSync: false,
      restore: { phase: "documents" },
    }),
  ).toBe("Bringing documents onto this machine…");
});

test("an interrupted restore says what is missing and how it will not fix itself", () => {
  const failed = describeAccount(
    {
      state: "failed",
      lastError: "The document download failed.",
      restore: { phase: "documents" },
    },
    NOW,
  );
  expect(failed.headline).toBe(
    "Tasks arrived; document recovery was interrupted.",
  );
  expect(failed.detail).toContain("Automatic sync will retry");

  // With automatic sync off, no retry is coming, so none is promised.
  const pausedFailure = describeAccount(
    {
      state: "failed",
      lastError: "The document download failed.",
      autoSync: false,
      restore: { phase: "documents" },
    },
    NOW,
  );
  expect(pausedFailure.headline).toBe(
    "Tasks arrived; document recovery was interrupted.",
  );
  expect(pausedFailure.detail).toContain("Automatic sync is off");
});

test("an established machine's ordinary run is not narrated as a restore", () => {
  // The field stays behind after the first restore, so the states that follow
  // have to read it as history rather than as work still on its way.
  const settled = { phase: "ready", taskCount: 4 } as const;
  expect(
    headlineOf({ state: "syncing", startedAt: JUST_NOW, restore: settled }),
  ).toBe("Syncing…");
  expect(
    headlineOf({
      state: "failed",
      lastError: "The server refused the push.",
      restore: settled,
    }),
  ).toBe("Last sync failed.");
});
