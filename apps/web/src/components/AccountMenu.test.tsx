// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  REPLACEMENT_KEY_CONFIRMATION,
  type LoginAttemptView,
  type SyncStatusResponse,
} from "@trace/core/browser";
import { AccountMenu } from "./AccountMenu.tsx";

const NOW = new Date("2026-07-10T16:05:00.000Z");

const SIGNED_OUT: SyncStatusResponse = {
  state: "logged-out",
  serverConfigured: true,
  autoSync: true,
};

const WAITING: LoginAttemptView = {
  attemptId: "attempt-1",
  state: "waiting-for-approval",
  provider: "github",
  verificationUrl: "https://auth.test/device?user_code=ABCD-EFGH",
  userCode: "ABCD-EFGH",
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type LocalAuthFake = {
  fetch: ReturnType<typeof vi.fn>;
  calls: string[];
  /** Bodies of the requests the board sent, in order. */
  bodies: unknown[];
};

/**
 * A stand-in for the serving process's `/api/local-auth` endpoints: `started`
 * is what `POST /login` answers with, `polled` is what the board then sees
 * while it watches the attempt. Acknowledgement and cancellation move the
 * polled view on, exactly as the local service does.
 */
function localAuthServer(options: {
  status?: SyncStatusResponse;
  started?: LoginAttemptView;
  polled?: LoginAttemptView;
  /** The key this account's documents are encrypted under, for the
   * `waiting-for-existing-key` path: anything else is refused. */
  masterKey?: string;
}): LocalAuthFake {
  const started = options.started ?? WAITING;
  let polled = options.polled ?? started;
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetch = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (url === "/api/sync/status") {
      return jsonResponse(options.status ?? SIGNED_OUT);
    }
    if (url === "/api/local-auth/login") return jsonResponse(started);
    if (url === "/api/local-auth/logout") return jsonResponse({ ok: true });
    if (url.endsWith("/acknowledge-key")) {
      polled = { ...polled, state: "complete", generatedKey: undefined };
      return jsonResponse(polled);
    }
    if (url.endsWith("/existing-key")) {
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      polled =
        key === options.masterKey
          ? { ...polled, state: "complete", error: undefined }
          : {
              ...polled,
              error:
                "That document encryption key could not decrypt your synced documents.",
            };
      return jsonResponse(polled);
    }
    if (url.endsWith("/replacement-key")) {
      const { confirmation } = JSON.parse(String(init?.body)) as {
        confirmation: string;
      };
      polled =
        confirmation === REPLACEMENT_KEY_CONFIRMATION
          ? {
              ...polled,
              state: "showing-generated-key",
              generatedKey: GENERATED_KEY,
              error: undefined,
            }
          : { ...polled, error: `Type ${REPLACEMENT_KEY_CONFIRMATION} to confirm.` };
      return jsonResponse(polled);
    }
    if (url.endsWith("/cancel")) {
      polled = { ...polled, state: "cancelled" };
      return jsonResponse(polled);
    }
    if (url.startsWith("/api/local-auth/login/")) return jsonResponse(polled);
    return jsonResponse({});
  });
  return { fetch, calls, bodies };
}

/** Render the menu over a scripted local-auth server, with `window.open` stubbed. */
function renderWithLocalAuth(server: LocalAuthFake): { opened: string[] } {
  const opened: string[] = [];
  vi.stubGlobal("fetch", server.fetch);
  vi.stubGlobal(
    "open",
    vi.fn((url: string) => {
      opened.push(url);
      return null;
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AccountMenu now={NOW} />
    </QueryClientProvider>,
  );
  return { opened };
}

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
  // Account actions are allowed here; changing synchronization is not.
  expect(menu.querySelectorAll("input, [role='switch']")).toHaveLength(0);
  expect(menu).not.toHaveTextContent(/sync now/i);
  expect(menu).not.toHaveTextContent(/autosync.*(on|off)\s*$/i);
  expect(
    screen.queryByRole("button", { name: /sync now|autosync/i }),
  ).not.toBeInTheDocument();
});

test("a signed-out machine offers board login and carries no sync badge", async () => {
  const user = userEvent.setup();
  renderMenu({ state: "logged-out", serverConfigured: true, autoSync: true });

  const trigger = await screen.findByRole("button", { name: "Account — not signed in" });
  expect(trigger.querySelector("[data-sync-indicator]")).toBeNull();

  await user.click(trigger);
  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent("Not signed in");
  expect(
    await screen.findByRole("button", { name: /sign in with github/i }),
  ).toBeInTheDocument();
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

test("signing in with GitHub opens the hosted approval page and watches the attempt", async () => {
  const user = userEvent.setup();
  const server = localAuthServer({});
  const { opened } = renderWithLocalAuth(server);

  await user.click(await screen.findByRole("button", { name: /account/i }));
  await user.click(await screen.findByRole("button", { name: /sign in with github/i }));

  // The approval page is a separate tab so the local process keeps ownership of
  // the credentials it is about to receive.
  expect(opened).toEqual(["https://auth.test/device?user_code=ABCD-EFGH"]);
  expect(server.bodies).toContainEqual({ provider: "github" });

  const menu = await screen.findByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent(/waiting for approval/i);
  expect(menu).toHaveTextContent("ABCD-EFGH");
  expect(server.calls).toContain("GET /api/local-auth/login/attempt-1");
});

const GENERATED_KEY = "ab".repeat(32);

test("a newly generated key is shown once, kept out of storage, and acknowledged in place", async () => {
  const user = userEvent.setup();
  const server = localAuthServer({
    polled: {
      ...WAITING,
      state: "showing-generated-key",
      generatedKey: GENERATED_KEY,
    },
  });
  renderWithLocalAuth(server);

  await user.click(await screen.findByRole("button", { name: /account/i }));
  await user.click(await screen.findByRole("button", { name: /sign in with github/i }));

  expect(await screen.findByTestId("generated-key")).toHaveTextContent(GENERATED_KEY);
  expect(screen.getByRole("dialog", { name: /account/i })).toHaveTextContent(
    /shown only once/i,
  );
  // The key exists in component memory and nowhere a later reader could find it.
  expect(JSON.stringify(localStorage)).not.toContain(GENERATED_KEY);
  expect(JSON.stringify(sessionStorage)).not.toContain(GENERATED_KEY);
  expect(window.location.href).not.toContain(GENERATED_KEY);

  await user.click(screen.getByRole("button", { name: /i have saved it/i }));

  await waitFor(() =>
    expect(screen.queryByTestId("generated-key")).not.toBeInTheDocument(),
  );
  expect(server.calls).toContain(
    "POST /api/local-auth/login/attempt-1/acknowledge-key",
  );
});

const EXISTING_KEY = "cd".repeat(32);

/** Start a login that lands on the existing-key prompt. */
async function signInToKeyPrompt(server: LocalAuthFake): Promise<void> {
  const user = userEvent.setup();
  renderWithLocalAuth(server);
  await user.click(await screen.findByRole("button", { name: /account/i }));
  await user.click(await screen.findByRole("button", { name: /sign in with github/i }));
  await screen.findByLabelText(/document encryption key/i);
}

const WAITING_FOR_KEY: LoginAttemptView = {
  ...WAITING,
  state: "waiting-for-existing-key",
};

test("an account with synced documents asks for its key and signs in once it validates", async () => {
  const user = userEvent.setup();
  const server = localAuthServer({
    polled: WAITING_FOR_KEY,
    masterKey: EXISTING_KEY,
  });
  await signInToKeyPrompt(server);

  await user.type(screen.getByLabelText(/document encryption key/i), EXISTING_KEY);
  await user.click(screen.getByRole("button", { name: /^continue$/i }));

  await waitFor(() =>
    expect(server.calls).toContain(
      "POST /api/local-auth/login/attempt-1/existing-key",
    ),
  );
  expect(server.bodies).toContainEqual({ key: EXISTING_KEY });
  // A completed login is no longer an attempt: the prompt goes away.
  await waitFor(() =>
    expect(
      screen.queryByLabelText(/document encryption key/i),
    ).not.toBeInTheDocument(),
  );
});

test("a key that cannot decrypt the account is reported without losing the prompt", async () => {
  const user = userEvent.setup();
  const server = localAuthServer({
    polled: WAITING_FOR_KEY,
    masterKey: EXISTING_KEY,
  });
  await signInToKeyPrompt(server);

  await user.type(screen.getByLabelText(/document encryption key/i), "ef".repeat(32));
  await user.click(screen.getByRole("button", { name: /^continue$/i }));

  expect(await screen.findByTestId("existing-key-error")).toHaveTextContent(
    /could not decrypt/i,
  );
  // Still on the prompt, so the user can try the right key.
  expect(screen.getByLabelText(/document encryption key/i)).toBeInTheDocument();
});

test("a fresh key is offered only behind the same warning and confirmation the CLI demands", async () => {
  const user = userEvent.setup();
  const server = localAuthServer({
    polled: WAITING_FOR_KEY,
    masterKey: EXISTING_KEY,
  });
  await signInToKeyPrompt(server);

  await user.click(screen.getByRole("button", { name: /use a new key/i }));

  const menu = screen.getByRole("dialog", { name: /account/i });
  expect(menu).toHaveTextContent(/cannot decrypt your existing synced documents/i);
  const generate = screen.getByRole("button", { name: /generate new key/i });
  // The warning is not enough on its own: the phrase must be typed.
  expect(generate).toBeDisabled();

  await user.type(screen.getByLabelText(/confirm/i), REPLACEMENT_KEY_CONFIRMATION);
  await user.click(generate);

  await waitFor(() =>
    expect(server.calls).toContain(
      "POST /api/local-auth/login/attempt-1/replacement-key",
    ),
  );
  expect(server.bodies).toContainEqual({
    confirmation: REPLACEMENT_KEY_CONFIRMATION,
  });
  // The replacement is shown once, exactly as a new account's key is.
  expect(await screen.findByTestId("generated-key")).toHaveTextContent(
    GENERATED_KEY,
  );
});

test("an expired attempt explains itself and can be started again", async () => {
  const user = userEvent.setup();
  const server = localAuthServer({
    polled: {
      ...WAITING,
      state: "expired",
      error: "The sign-in request expired before it was approved.",
    },
  });
  renderWithLocalAuth(server);

  await user.click(await screen.findByRole("button", { name: /account/i }));
  await user.click(await screen.findByRole("button", { name: /sign in with github/i }));

  expect(await screen.findByTestId("login-outcome")).toHaveTextContent(
    "The sign-in request expired before it was approved.",
  );

  await user.click(screen.getByRole("button", { name: /try again/i }));

  expect(
    server.calls.filter((call) => call === "POST /api/local-auth/login"),
  ).toHaveLength(2);
});

test("cancelling a sign-in is an explicit action that settles the attempt", async () => {
  const user = userEvent.setup();
  const server = localAuthServer({});
  renderWithLocalAuth(server);

  await user.click(await screen.findByRole("button", { name: /account/i }));
  await user.click(await screen.findByRole("button", { name: /sign in with github/i }));
  await screen.findByText(/waiting for approval/i);

  await user.click(screen.getByRole("button", { name: /cancel sign-in/i }));

  expect(server.calls).toContain("POST /api/local-auth/login/attempt-1/cancel");
  expect(await screen.findByTestId("login-outcome")).toHaveTextContent(
    /cancelled/i,
  );
});

test("a signed-in machine can be signed out from the menu", async () => {
  const user = userEvent.setup();
  const server = localAuthServer({
    status: {
      state: "synced",
      identity: "The Octocat",
      lastSyncedAt: "2026-07-10T16:03:00.000Z",
      autoSync: true,
    },
  });
  renderWithLocalAuth(server);

  await user.click(await screen.findByRole("button", { name: /account/i }));
  await user.click(await screen.findByRole("button", { name: /sign out/i }));

  await waitFor(() =>
    expect(server.calls).toContain("POST /api/local-auth/logout"),
  );
  // Signing out never offers to sign in with a provider in the same breath.
  expect(screen.queryByRole("button", { name: /sign in with/i })).not.toBeInTheDocument();
});
