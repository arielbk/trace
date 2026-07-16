import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readSyncStatus } from "@trace/core";
import { runAuthCommand } from "./auth.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("login polls the device flow and persists its bearer token privately", async () => {
  const home = tmp("trace-auth-home-");
  const requests: Array<{ url: string; body?: unknown }> = [];
  const openedUrls: string[] = [];
  let polls = 0;

  try {
    const result = await runAuthCommand(
      "login",
      { HOME: home, TRACE_SERVER_URL: "http://auth.test/" },
      {
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          });
          if (String(url).endsWith("/device/code")) {
            return Response.json({
              device_code: "device-code",
              user_code: "ABCD-EFGH",
              verification_uri: "https://github.com/login/device",
              verification_uri_complete:
                "https://github.com/login/device?user_code=ABCD-EFGH",
              interval: 0,
            });
          }
          if (String(url).endsWith("/get-session")) {
            return Response.json({
              user: { name: "The Octocat", email: "octocat@github.com" },
            });
          }
          polls += 1;
          return polls === 1
            ? Response.json(
                { error: "authorization_pending" },
                { status: 400 },
              )
            : Response.json({ access_token: "bearer-token" });
        },
        openBrowser: (url) => openedUrls.push(url),
        sleep: async () => undefined,
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        "Visit https://github.com/login/device?user_code=ABCD-EFGH\nCode: ABCD-EFGH\nSigned in.\n",
      stderr: "",
    });
    expect(openedUrls).toEqual([
      "https://github.com/login/device?user_code=ABCD-EFGH",
    ]);
    expect(requests).toEqual([
      {
        url: "http://auth.test/api/auth/device/code",
        body: { client_id: "trace-cli" },
      },
      {
        url: "http://auth.test/api/auth/device/token",
        body: {
          client_id: "trace-cli",
          device_code: "device-code",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      },
      {
        url: "http://auth.test/api/auth/device/token",
        body: {
          client_id: "trace-cli",
          device_code: "device-code",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      },
      {
        url: "http://auth.test/api/auth/get-session",
        body: undefined,
      },
    ]);
    expect(JSON.parse(readFileSync(join(home, ".trace", "auth.json"), "utf8"))).toEqual({
      accessToken: "bearer-token",
    });
    expect(statSync(join(home, ".trace")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".trace", "auth.json")).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("whoami reads the stored bearer token and logout clears it", async () => {
  const home = tmp("trace-auth-home-");
  const authDir = join(home, ".trace");

  try {
    const loggedIn = await runAuthCommand(
      "login",
      { HOME: home, TRACE_SERVER_URL: "http://auth.test" },
      {
        fetch: async (url) =>
          String(url).endsWith("/device/code")
            ? Response.json({
                device_code: "device-code",
                user_code: "ABCD-EFGH",
                verification_uri: "https://github.com/login/device",
                interval: 0,
              })
            : Response.json({ access_token: "bearer-token" }),
        sleep: async () => undefined,
      },
    );
    expect(loggedIn.exitCode).toBe(0);

    const whoami = await runAuthCommand(
      "whoami",
      { HOME: home, TRACE_SERVER_URL: "http://auth.test" },
      {
        fetch: async (url, init) => {
          expect(url).toBe("http://auth.test/api/auth/get-session");
          expect(init?.headers).toEqual({
            authorization: "Bearer bearer-token",
          });
          return Response.json({
            user: { name: "The Octocat", email: "octocat@github.com" },
          });
        },
        sleep: async () => undefined,
      },
    );
    expect(whoami).toEqual({
      exitCode: 0,
      stdout: "The Octocat <octocat@github.com>\n",
      stderr: "",
    });

    expect(await runAuthCommand("logout", { HOME: home })).toEqual({
      exitCode: 0,
      stdout: "Signed out.\n",
      stderr: "",
    });
    expect(() => readFileSync(join(authDir, "auth.json"))).toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("whoami treats a null session as logged out", async () => {
  const home = tmp("trace-auth-home-");

  try {
    await runAuthCommand(
      "login",
      { HOME: home, TRACE_SERVER_URL: "http://auth.test" },
      {
        fetch: async (url) =>
          String(url).endsWith("/device/code")
            ? Response.json({
                device_code: "device-code",
                user_code: "ABCD-EFGH",
                verification_uri: "https://github.com/login/device",
                interval: 0,
              })
            : Response.json({ access_token: "invalidated-token" }),
        openBrowser: () => {},
        sleep: async () => undefined,
      },
    );

    const result = await runAuthCommand(
      "whoami",
      { HOME: home, TRACE_SERVER_URL: "http://auth.test" },
      { fetch: async () => Response.json(null) },
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Not logged in. Run trace login.\n",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("login records the signed-in identity and logout clears it for the board", async () => {
  const home = tmp("trace-auth-home-");
  const databasePath = join(home, ".trace", "trace.sqlite");

  try {
    await runAuthCommand(
      "login",
      { HOME: home, TRACE_SERVER_URL: "http://auth.test" },
      {
        fetch: async (url) => {
          if (String(url).endsWith("/device/code")) {
            return Response.json({
              device_code: "device-code",
              user_code: "ABCD-EFGH",
              verification_uri: "https://github.com/login/device",
              interval: 0,
            });
          }
          if (String(url).endsWith("/get-session")) {
            return Response.json({
              user: { name: "The Octocat", email: "octocat@github.com" },
            });
          }
          return Response.json({ access_token: "bearer-token" });
        },
        sleep: async () => undefined,
      },
    );

    // Logged in but not yet synced: identity is known, no sync time yet.
    expect(readSyncStatus(databasePath)).toEqual({
      state: "never-synced",
      identity: "The Octocat <octocat@github.com>",
    });

    await runAuthCommand("logout", { HOME: home });
    expect(readSyncStatus(databasePath)).toEqual({ state: "logged-out" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
