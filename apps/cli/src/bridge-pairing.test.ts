import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openConnectionCredentials } from "./connection-credentials.ts";
import {
  createBridgePairingUrl,
  createPairingLinks,
  MAX_OUTSTANDING_PAIRING_LINKS,
  PAIRING_LINK_TTL_MS,
} from "./bridge-pairing.ts";

function fakeIssuer(): (label: string) => { id: string; token: string } {
  let issued = 0;
  return (label) => {
    issued += 1;
    return { id: `browser-${issued}`, token: `${label}-token-${issued}` };
  };
}

test("a pairing link mints one browser credential and cannot be replayed", () => {
  const links = createPairingLinks(fakeIssuer());

  const link = links.create();
  expect(link.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(links.exchange("wrong-secret")).toBeNull();
  expect(links.exchange(link.secret)).toBe("Paired browser-token-1");
  expect(links.exchange(link.secret)).toBeNull();
});

test("a pairing link stops working five minutes after it was created", () => {
  let now = 1_000;
  const links = createPairingLinks(fakeIssuer(), { now: () => now });

  const link = links.create();
  expect(link.expiresAt).toBe(1_000 + PAIRING_LINK_TTL_MS);

  now += PAIRING_LINK_TTL_MS + 1;
  expect(links.exchange(link.secret)).toBeNull();
});

test("outstanding pairing links are capped, retiring the oldest first", () => {
  const links = createPairingLinks(fakeIssuer());

  const created = Array.from({ length: MAX_OUTSTANDING_PAIRING_LINKS + 1 }, () =>
    links.create(),
  );

  expect(links.exchange(created[0]!.secret)).toBeNull();
  expect(links.exchange(created[1]!.secret)).not.toBeNull();
  expect(links.exchange(created.at(-1)!.secret)).not.toBeNull();
});

test("the pairing URL keeps its one-time secret in the fragment", () => {
  const url = createBridgePairingUrl("https://trace.example", "s3cret");

  expect(url).toBe("https://trace.example/#trace-pair=s3cret");
  expect(new URL(url).search).toBe("");
});

test("two links exchanged back to back mint two distinct browsers", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-pairing-store-"));
  try {
    const connection = openConnectionCredentials({ HOME: home });
    const links = createPairingLinks(connection.issueBrowserToken);
    const [first, second] = [links.create(), links.create()];

    const tokens = [first, second].map((link) => links.exchange(link.secret));

    expect(new Set(tokens).size).toBe(2);
    expect(connection.listBrowsers()).toHaveLength(2);
    for (const token of tokens) {
      expect(connection.verifyBrowserToken(token as string)).not.toBeNull();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a restart drops outstanding links but keeps the browsers already paired", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-pairing-restart-"));
  try {
    const connection = openConnectionCredentials({ HOME: home });
    const before = createPairingLinks(connection.issueBrowserToken);
    const paired = before.exchange(before.create().secret) as string;
    const abandoned = before.create();

    // Restarting the service means new in-memory links against the same store.
    const after = createPairingLinks(
      openConnectionCredentials({ HOME: home }).issueBrowserToken,
    );

    expect(after.exchange(abandoned.secret)).toBeNull();
    expect(
      openConnectionCredentials({ HOME: home }).verifyBrowserToken(paired),
    ).not.toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
