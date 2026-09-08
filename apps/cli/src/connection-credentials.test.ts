import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveBridgeCredentialPath } from "./bridge-credential.ts";
import {
  LEGACY_BROWSER_LABEL,
  openConnectionCredentials,
  resolveConnectionCredentialsPath,
} from "./connection-credentials.ts";

const homes: string[] = [];

function makeHome(): { HOME: string } {
  const home = mkdtempSync(join(tmpdir(), "trace-connection-credentials-"));
  homes.push(home);
  return { HOME: home };
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the local management credential is generated once and stored owner-only", () => {
  const env = makeHome();

  const first = openConnectionCredentials(env).managementToken;
  const second = openConnectionCredentials(env).managementToken;
  const path = resolveConnectionCredentialsPath(env);

  expect(first).toBe(second);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(statSync(join(env.HOME, ".trace")).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8")).browsers).toEqual([]);
});

test("each paired browser gets its own token, persisted only as a digest", () => {
  const env = makeHome();
  const credentials = openConnectionCredentials(env);

  const laptop = credentials.issueBrowserToken("Safari");
  const phone = credentials.issueBrowserToken("Chrome");

  expect(laptop.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(phone.token).not.toBe(laptop.token);
  expect(credentials.verifyBrowserToken(laptop.token)?.id).toBe(laptop.id);
  expect(credentials.verifyBrowserToken(phone.token)?.id).toBe(phone.id);
  expect(credentials.verifyBrowserToken("not-a-paired-token")).toBeNull();

  expect(credentials.listBrowsers()).toEqual([
    { id: laptop.id, label: "Safari", pairedAt: expect.any(String) },
    { id: phone.id, label: "Chrome", pairedAt: expect.any(String) },
  ]);

  const stored = readFileSync(resolveConnectionCredentialsPath(env), "utf8");
  expect(stored).not.toContain(laptop.token);
  expect(stored).not.toContain(phone.token);
});

test("revoking one browser leaves the others connected, immediately", () => {
  const env = makeHome();
  const serving = openConnectionCredentials(env);
  const laptop = serving.issueBrowserToken("Safari");
  const phone = serving.issueBrowserToken("Chrome");

  // A second handle stands in for the CLI process talking to the same state.
  expect(openConnectionCredentials(env).revokeBrowser(phone.id)).toBe(true);

  expect(serving.verifyBrowserToken(phone.token)).toBeNull();
  expect(serving.verifyBrowserToken(laptop.token)?.id).toBe(laptop.id);
  expect(serving.listBrowsers().map((browser) => browser.id)).toEqual([
    laptop.id,
  ]);
  expect(serving.revokeBrowser("never-paired")).toBe(false);
});

test("reset revokes every browser but keeps local management access", () => {
  const env = makeHome();
  const credentials = openConnectionCredentials(env);
  const laptop = credentials.issueBrowserToken("Safari");

  credentials.reset();

  expect(credentials.verifyBrowserToken(laptop.token)).toBeNull();
  expect(credentials.listBrowsers()).toEqual([]);
  expect(openConnectionCredentials(env).managementToken).toBe(
    credentials.managementToken,
  );
});

test("an existing installation credential migrates to one revocable legacy browser", () => {
  const env = makeHome();
  const legacyToken = "l3gacy".padEnd(43, "x");
  mkdirSync(join(env.HOME, ".trace"), { recursive: true });
  writeFileSync(
    resolveBridgeCredentialPath(env),
    JSON.stringify({ token: legacyToken }),
  );

  const credentials = openConnectionCredentials(env);
  const browsers = credentials.listBrowsers();

  expect(browsers).toHaveLength(1);
  expect(browsers[0]!.label).toBe(LEGACY_BROWSER_LABEL);
  expect(credentials.verifyBrowserToken(legacyToken)!.id).toBe(browsers[0]!.id);

  credentials.revokeBrowser(browsers[0]!.id);

  // Revoking the migrated credential is final: reopening must not resurrect it
  // from the bridge.json file it came from.
  const reopened = openConnectionCredentials(env);
  expect(reopened.listBrowsers()).toEqual([]);
  expect(reopened.verifyBrowserToken(legacyToken)).toBeNull();
});

test("malformed connection state fails closed instead of minting new authority", () => {
  const env = makeHome();
  openConnectionCredentials(env);
  const path = resolveConnectionCredentialsPath(env);
  writeFileSync(path, "{ not json");

  expect(() => openConnectionCredentials(env)).toThrow(path);
});
