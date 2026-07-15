// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SyncStatus } from "@trace/core/browser";
import { SyncStatusBadge, describeSyncStatus } from "./SyncStatusBadge.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const NOW = new Date("2026-07-10T16:05:00.000Z");

describe("describeSyncStatus", () => {
  test("logged-out with a configured server points the user at the CLI login command", () => {
    expect(
      describeSyncStatus({ state: "logged-out", serverConfigured: true }),
    ).toEqual({
      text: "not logged in — run `trace login`",
    });
  });

  test("logged-out without a configured server renders nothing", () => {
    expect(describeSyncStatus({ state: "logged-out" })).toBeNull();
    expect(
      describeSyncStatus({ state: "logged-out", serverConfigured: false }),
    ).toBeNull();
  });

  test("synced shows the identity and a relative time", () => {
    expect(
      describeSyncStatus(
        {
          state: "synced",
          identity: "The Octocat",
          lastSyncedAt: "2026-07-10T16:03:00.000Z",
        },
        NOW,
      ),
    ).toEqual({ text: "The Octocat · synced 2m ago" });
  });

  test("failed shows the identity, a sync-failed label, and the error as a title", () => {
    expect(
      describeSyncStatus({
        state: "failed",
        identity: "The Octocat",
        lastError: "server returned 500",
      }),
    ).toEqual({
      text: "The Octocat · sync failed",
      title: "server returned 500",
    });
  });

  test("never-synced shows the identity awaiting a first sync", () => {
    expect(
      describeSyncStatus({ state: "never-synced", identity: "The Octocat" }),
    ).toEqual({ text: "The Octocat · not synced yet" });
  });

  test("an absent or malformed status renders nothing", () => {
    expect(describeSyncStatus(undefined)).toBeNull();
    expect(describeSyncStatus({} as SyncStatus)).toBeNull();
  });
});

describe("SyncStatusBadge", () => {
  function renderBadge(status: SyncStatus) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(status), { status: 200 })),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(SyncStatusBadge, { now: NOW }),
      ),
    );
  }

  test("renders the logged-out prompt once the status resolves", async () => {
    renderBadge({ state: "logged-out", serverConfigured: true });
    expect(
      await screen.findByText("not logged in — run `trace login`"),
    ).toBeInTheDocument();
  });

  test("renders nothing when logged out with no server configured", async () => {
    const { container } = renderBadge({ state: "logged-out", serverConfigured: false });
    // Let the query resolve, then confirm the badge stayed empty.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  test("renders the synced identity and relative time", async () => {
    renderBadge({
      state: "synced",
      identity: "The Octocat",
      lastSyncedAt: "2026-07-10T16:03:00.000Z",
    });
    expect(
      await screen.findByText("The Octocat · synced 2m ago"),
    ).toBeInTheDocument();
  });

  test("renders nothing before the status resolves", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(SyncStatusBadge, {}),
      ),
    );
    // Give the query a tick; it stays pending, so the badge is empty.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
