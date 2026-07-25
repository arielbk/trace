import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSyncStatus } from "@trace/core";
import { createLocalAuthService } from "./local-auth.ts";
import { readStoredDocCryptoKey } from "./commands/key.ts";
import { createServeRequestListener } from "./serve.ts";

let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trace-local-auth-"));
  env = { HOME: home, TRACE_SERVER_URL: "http://auth.test" };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

type HostedRequest = { url: string; body?: unknown };

/**
 * A fake hosted auth server: RFC 8628 device code, a token endpoint that stays
 * pending until {@link HostedAuth.approve} is called, the document manifests
 * the account holds, and a session identity.
 */
type HostedAuth = {
  fetch: typeof globalThis.fetch;
  requests: HostedRequest[];
  approve: () => void;
};

function hostedAuth(
  account: {
    manifests?: unknown[];
    wrappedKeys?: unknown[];
    /** Device-code lifetime; the default is long enough never to expire mid-test. */
    expiresIn?: number;
  } = {},
): HostedAuth {
  let approved = false;
  const requests: HostedRequest[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/device/code")) {
      return Response.json({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.test/device",
        verification_uri_complete: "https://auth.test/device?user_code=ABCD-EFGH",
        interval: 0,
        expires_in: account.expiresIn ?? 3_600,
      });
    }
    if (url.endsWith("/device/token")) {
      return approved
        ? Response.json({ access_token: "bearer-token" })
        : Response.json({ error: "authorization_pending" }, { status: 400 });
    }
    if (url.endsWith("/docs/manifests")) {
      return Response.json({
        manifests: account.manifests ?? [],
        wrappedKeys: account.wrappedKeys ?? [],
      });
    }
    if (url.endsWith("/get-session")) {
      return Response.json({
        user: { name: "The Octocat", email: "octocat@github.com" },
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests, approve: () => (approved = true) };
}

type Listener = (req: IncomingMessage, res: ServerResponse) => void;

/** The `trace serve` request listener over a local auth service that talks to
 * `hosted` instead of the real sync server. */
function makeListener(hosted: HostedAuth): Listener {
  return createServeRequestListener(
    join(home, ".trace", "trace.sqlite"),
    undefined,
    true,
    undefined,
    undefined,
    createLocalAuthService(env, {
      fetch: hosted.fetch,
      sleep: async () => undefined,
    }),
  );
}

type CapturedResponse = { status: number; body: string };

/** Drive one request through the listener, resolving when it responds. */
function request(
  listener: Listener,
  method: string,
  url: string,
  body?: string,
): Promise<CapturedResponse> {
  return new Promise((resolve) => {
    const captured: CapturedResponse = { status: 200, body: "" };
    const res = {
      set statusCode(value: number) {
        captured.status = value;
      },
      get statusCode() {
        return captured.status;
      },
      setHeader() {},
      end(chunk?: string) {
        captured.body = chunk ?? "";
        resolve(captured);
      },
    } as unknown as ServerResponse;

    const req = Object.assign(new EventEmitter(), {
      method,
      url,
    }) as unknown as IncomingMessage;
    listener(req, res);
    if (method === "POST") {
      if (body !== undefined) req.emit("data", Buffer.from(body));
      req.emit("end");
    }
  });
}

type AttemptView = {
  attemptId: string;
  state: string;
  provider: string;
  verificationUrl: string;
  userCode: string;
  generatedKey?: string;
  identity?: string;
  error?: string;
};

async function startLogin(
  listener: Listener,
  provider = "github",
): Promise<AttemptView> {
  const response = await request(
    listener,
    "POST",
    "/api/local-auth/login",
    JSON.stringify({ provider }),
  );
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as AttemptView;
}

function readAttemptResponse(
  listener: Listener,
  attemptId: string,
): Promise<CapturedResponse> {
  return request(listener, "GET", `/api/local-auth/login/${attemptId}`);
}

async function readAttempt(
  listener: Listener,
  attemptId: string,
): Promise<AttemptView> {
  const response = await readAttemptResponse(listener, attemptId);
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as AttemptView;
}

/** Poll the attempt until the detached device sequence reaches `state`. */
async function waitForState(
  listener: Listener,
  attemptId: string,
  state: string,
): Promise<AttemptView> {
  for (let poll = 0; poll < 500; poll += 1) {
    const attempt = await readAttempt(listener, attemptId);
    if (attempt.state === state) return attempt;
  }
  throw new Error(`login attempt never reached ${state}`);
}

test("the board starts a login and receives an attempt plus the hosted verification URL", async () => {
  const hosted = hostedAuth();

  const attempt = await startLogin(makeListener(hosted));

  expect(attempt).toMatchObject({
    state: "waiting-for-approval",
    provider: "github",
    verificationUrl: "https://auth.test/device?user_code=ABCD-EFGH",
    userCode: "ABCD-EFGH",
  });
  expect(attempt.attemptId).toEqual(expect.any(String));
  expect(hosted.requests[0]).toEqual({
    url: "http://auth.test/api/auth/device/code",
    body: { client_id: "trace-cli", provider: "github" },
  });
});

test("an unapproved attempt keeps reporting that it waits for the browser", async () => {
  const hosted = hostedAuth();
  const listener = makeListener(hosted);

  const started = await startLogin(listener);
  const polled = await readAttempt(listener, started.attemptId);

  expect(polled.state).toBe("waiting-for-approval");
  expect(polled.attemptId).toBe(started.attemptId);
  // The device code is being polled while the user is away in the browser.
  expect(
    hosted.requests.filter((entry) => entry.url.endsWith("/device/token")).length,
  ).toBeGreaterThan(0);
});

test("approving an empty account generates a document key and stores the credentials", async () => {
  const hosted = hostedAuth();
  const listener = makeListener(hosted);
  const started = await startLogin(listener);

  hosted.approve();
  const attempt = await waitForState(
    listener,
    started.attemptId,
    "showing-generated-key",
  );

  // The key is shown once so the user can save it — this is the only recovery
  // material they will ever get.
  expect(attempt.generatedKey).toMatch(/^[0-9a-f]{64}$/);
  expect(readStoredDocCryptoKey(env)).toBe(attempt.generatedKey);
  expect(
    JSON.parse(readFileSync(join(home, ".trace", "auth.json"), "utf8")),
  ).toEqual({ accessToken: "bearer-token" });
  expect(readSyncStatus(join(home, ".trace", "trace.sqlite"))).toEqual({
    state: "never-synced",
    identity: "The Octocat <octocat@github.com>",
  });
});

test("acknowledging the generated key completes the login and shows the key no more", async () => {
  const hosted = hostedAuth();
  const listener = makeListener(hosted);
  const started = await startLogin(listener);
  hosted.approve();
  await waitForState(listener, started.attemptId, "showing-generated-key");

  const acknowledged = await request(
    listener,
    "POST",
    `/api/local-auth/login/${started.attemptId}/acknowledge-key`,
  );

  expect(acknowledged.status).toBe(200);
  const attempt = JSON.parse(acknowledged.body) as AttemptView;
  expect(attempt.state).toBe("complete");
  expect(attempt.identity).toBe("The Octocat <octocat@github.com>");
  expect(attempt.generatedKey).toBeUndefined();
  // Nor does the key come back on a later poll.
  expect(
    (await readAttempt(listener, started.attemptId)).generatedKey,
  ).toBeUndefined();
});

test("signing out from the board clears the bearer token and the board's status", async () => {
  const hosted = hostedAuth();
  const listener = makeListener(hosted);
  const started = await startLogin(listener);
  hosted.approve();
  await waitForState(listener, started.attemptId, "showing-generated-key");

  const response = await request(listener, "POST", "/api/local-auth/logout");

  expect(response.status).toBe(200);
  expect(existsSync(join(home, ".trace", "auth.json"))).toBe(false);
  expect(readSyncStatus(join(home, ".trace", "trace.sqlite"))).toEqual({
    state: "logged-out",
  });
  // Logging out is not abandoning the ability to read already-synced documents.
  expect(readStoredDocCryptoKey(env)).toMatch(/^[0-9a-f]{64}$/);
});

test("cancelling an attempt stops the device polling and stores nothing", async () => {
  const hosted = hostedAuth();
  const listener = makeListener(hosted);
  const started = await startLogin(listener);

  const cancelled = await request(
    listener,
    "POST",
    `/api/local-auth/login/${started.attemptId}/cancel`,
  );

  expect(cancelled.status).toBe(200);
  expect((JSON.parse(cancelled.body) as AttemptView).state).toBe("cancelled");

  // Approval after the fact must not revive a cancelled attempt.
  hosted.approve();
  const polls = hosted.requests.length;
  for (let i = 0; i < 5; i += 1) {
    expect((await readAttempt(listener, started.attemptId)).state).toBe(
      "cancelled",
    );
  }
  expect(hosted.requests.length).toBe(polls);
  expect(existsSync(join(home, ".trace", "auth.json"))).toBe(false);
});

test("an unapproved device code expires instead of polling forever", async () => {
  // interval 0 is floored to the RFC 8628 minimum of 5s, so a 10s lifetime
  // allows exactly two polls before the attempt gives up.
  const hosted = hostedAuth({ expiresIn: 10 });
  const listener = makeListener(hosted);
  const started = await startLogin(listener);

  const attempt = await waitForState(listener, started.attemptId, "expired");

  expect(attempt.error).toMatch(/expired/i);
  expect(existsSync(join(home, ".trace", "auth.json"))).toBe(false);
});

test("no local-auth response ever carries the bearer token to the browser", async () => {
  const hosted = hostedAuth();
  const listener = makeListener(hosted);
  const bodies: string[] = [];

  const started = await startLogin(listener);
  bodies.push(JSON.stringify(started));
  hosted.approve();
  bodies.push(
    JSON.stringify(
      await waitForState(listener, started.attemptId, "showing-generated-key"),
    ),
  );
  bodies.push(
    (
      await request(
        listener,
        "POST",
        `/api/local-auth/login/${started.attemptId}/acknowledge-key`,
      )
    ).body,
  );
  bodies.push((await request(listener, "POST", "/api/local-auth/logout")).body);

  // The token was really issued — this is not a vacuous assertion.
  expect(
    hosted.requests.some((entry) => entry.url.endsWith("/device/token")),
  ).toBe(true);
  for (const body of bodies) {
    expect(body).not.toContain("bearer-token");
    expect(body).not.toContain("accessToken");
  }
});

test("an account holding synced documents stops for its key instead of signing in", async () => {
  const hosted = hostedAuth({ manifests: [{ taskId: "task-1" }] });
  const listener = makeListener(hosted);
  const started = await startLogin(listener);

  hosted.approve();
  const attempt = await waitForState(
    listener,
    started.attemptId,
    "waiting-for-existing-key",
  );

  expect(attempt.generatedKey).toBeUndefined();
  // No key, no credentials: an abandoned key step leaves the machine signed out
  // rather than half signed in.
  expect(existsSync(join(home, ".trace", "auth.json"))).toBe(false);
  expect(readStoredDocCryptoKey(env)).toBeNull();
});

test("the endpoints refuse what they cannot serve", async () => {
  const hosted = hostedAuth();
  const listener = makeListener(hosted);

  // A board tab left open across a `trace serve` restart holds a dead attempt.
  expect((await readAttemptResponse(listener, "no-such-attempt")).status).toBe(404);
  expect(
    (
      await request(
        listener,
        "POST",
        "/api/local-auth/login",
        JSON.stringify({ provider: "myspace" }),
      )
    ).status,
  ).toBe(400);
});

test("a machine with no sync server cannot start a login", async () => {
  env = { HOME: home };
  const response = await request(
    makeListener(hostedAuth()),
    "POST",
    "/api/local-auth/login",
    JSON.stringify({ provider: "github" }),
  );

  expect(response.status).toBe(400);
  expect(response.body).toContain("No sync server configured");
});
