// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { SyncStatusResponse } from "@trace/core/browser";
import { AccountMenu } from "./AccountMenu.tsx";

const NOW = new Date("2026-07-10T16:05:00.000Z");

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** Render the menu over a stubbed `GET /api/sync/status` payload. */
function renderMenu(status: SyncStatusResponse) {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(status), { status: 200 })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AccountMenu now={NOW} />
    </QueryClientProvider>,
  );
}

/** The account trigger, once the first status has resolved. */
function findTrigger(): Promise<HTMLElement> {
  return screen.findByRole("button", { name: /account/i });
}

test("the trigger names the account and the sync state behind it", async () => {
  renderMenu({
    state: "synced",
    identity: "The Octocat",
    lastSyncedAt: "2026-07-10T16:03:00.000Z",
    autoSync: true,
  });

  // The control is there from the first paint; the state joins its name once
  // the local status resolves.
  expect(screen.getByRole("button", { name: "Account" })).toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Account — last synced 2m ago" }),
  ).toBeInTheDocument();
});

test("the popover shows the identity, AutoSync mode, and last sync time", async () => {
  const user = userEvent.setup();
  renderMenu({
    state: "synced",
    identity: "The Octocat",
    lastSyncedAt: "2026-07-10T16:03:00.000Z",
    autoSync: true,
  });

  await user.click(await findTrigger());

  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent("The Octocat");
  expect(menu).toHaveTextContent("Last synced 2m ago");
  expect(menu).toHaveTextContent(/AutoSync\s*On/);
  // Trace cannot know whether another machine has unpublished changes.
  expect(menu).not.toHaveTextContent(/up to date/i);
});

test("a run in flight shows a spinner and keeps the last successful sync visible", async () => {
  const user = userEvent.setup();
  renderMenu({
    state: "syncing",
    identity: "The Octocat",
    startedAt: "2026-07-10T16:04:55.000Z",
    lastSyncedAt: "2026-07-10T16:00:00.000Z",
    autoSync: true,
  });

  const trigger = await screen.findByRole("button", { name: "Account — syncing" });
  expect(trigger.querySelector("[data-sync-indicator='syncing']")).toBeTruthy();

  await user.click(trigger);
  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent("Syncing…");
  expect(menu).toHaveTextContent("Last synced 5m ago");
});

test("a failure warns on the trigger and explains itself with the last success", async () => {
  const user = userEvent.setup();
  renderMenu({
    state: "failed",
    identity: "The Octocat",
    lastError: "server returned 500",
    lastSyncedAt: "2026-07-10T16:00:00.000Z",
    autoSync: true,
  });

  const trigger = await screen.findByRole("button", { name: "Account — sync failed" });
  expect(trigger.querySelector("[data-sync-indicator='failed']")).toBeTruthy();

  await user.click(trigger);
  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent("Last sync failed.");
  expect(menu).toHaveTextContent("server returned 500");
  // How stale the local state is still matters after a failure.
  expect(menu).toHaveTextContent("Last synced 5m ago");
});

test("manual mode is reported as read-only state, with no way to sync or switch", async () => {
  const user = userEvent.setup();
  renderMenu({
    state: "never-synced",
    identity: "The Octocat",
    autoSync: false,
  });

  await user.click(await screen.findByRole("button", { name: "Account — not synced yet" }));

  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent("Off — manual sync only");
  // AutoSync is a machine-local CLI setting, and on-demand sync is `trace sync`.
  expect(menu.querySelectorAll("button, input, [role='switch']")).toHaveLength(0);
  expect(menu).not.toHaveTextContent(/sync now/i);
});

test("a signed-out machine offers login through the CLI and carries no sync badge", async () => {
  const user = userEvent.setup();
  renderMenu({ state: "logged-out", serverConfigured: true, autoSync: true });

  const trigger = await screen.findByRole("button", { name: "Account — not signed in" });
  expect(trigger.querySelector("[data-sync-indicator]")).toBeNull();

  await user.click(trigger);
  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent("Not signed in");
  expect(menu).toHaveTextContent("trace login");
});

test("a machine with no sync server says Cloud Sync is unavailable rather than offering it", async () => {
  const user = userEvent.setup();
  renderMenu({ state: "logged-out", serverConfigured: false, autoSync: true });

  await user.click(
    await screen.findByRole("button", { name: "Account — Cloud Sync not configured" }),
  );

  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent("Cloud Sync is not configured on this machine.");
  expect(menu).not.toHaveTextContent("trace login");
});

test("the menu opens from the keyboard and Escape returns focus to the trigger", async () => {
  const user = userEvent.setup();
  renderMenu({
    state: "synced",
    identity: "The Octocat",
    lastSyncedAt: "2026-07-10T16:03:00.000Z",
    autoSync: true,
  });

  const trigger = await screen.findByRole("button", { name: /account/i });
  trigger.focus();
  await user.keyboard("{Enter}");

  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toBeInTheDocument();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: /account/i })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test("the spinner is animated by a class the stylesheet silences under reduced motion", async () => {
  renderMenu({
    state: "syncing",
    startedAt: "2026-07-10T16:04:55.000Z",
    autoSync: true,
  });

  const trigger = await screen.findByRole("button", { name: "Account — syncing" });
  const spinner = trigger.querySelector("[data-sync-indicator='syncing'] svg");
  // The board opts out of motion in CSS rather than per component; the
  // stylesheet silences this class (see styles.test.ts).
  expect(spinner).toHaveClass("t-sync-spinner");
});
