import { expect, test } from "vitest";
import {
  createKeyTransferApprover,
  createKeyTransferRecipient,
  createKeyWrapper,
  generateTaskKey,
  type SyncWrappedKey,
} from "@trace/core";
import { FakeCloud } from "./fake-sync-server.ts";
import { createKeyTransferRelay } from "./key-transfer-relay.ts";
import {
  createKeyTransferApproverSession,
  startKeyTransferRequest,
} from "./key-transfer-session.ts";

/**
 * The ceremony either machine runs around the arithmetic: the new machine's
 * request and the trusted machine's approval, each driving the relay on its
 * own and neither taking the relay's word for anything.
 */

const ACCOUNT = "octocat";

function relayFor(cloud: FakeCloud) {
  return createKeyTransferRelay({
    serverUrl: cloud.url,
    fetch: cloud.fetch,
    accessToken: "cloud-token",
  });
}

/** What the account's documents are wrapped with — the only evidence B has
 * that a delivered key is the right one. */
function wrappedKeysFor(masterKey: string): SyncWrappedKey[] {
  const wrapper = createKeyWrapper(masterKey);
  return [{ taskId: "task-1", wrappedKey: wrapper.wrapTaskKey(generateTaskKey()) }];
}

/** Poll intervals collapse to a yield, so a test runs the exchange at the
 * speed of the event loop rather than the relay's one-second cadence. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(() => resolve()));

async function sessions(cloud: FakeCloud, masterKey: string) {
  const recipient = await startKeyTransferRequest({
    relay: relayFor(cloud),
    machineName: "B's MacBook",
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    wrappedKeys: wrappedKeysFor(masterKey),
    sleep: tick,
  });
  const approver = createKeyTransferApproverSession({
    relay: relayFor(cloud),
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    masterKey,
    sleep: tick,
  });
  return { recipient, approver };
}

/** Poll a session's view until `predicate` holds, the way a board tab does. */
async function until<T>(read: () => T, predicate: (view: T) => boolean): Promise<T> {
  for (let poll = 0; poll < 500; poll += 1) {
    const view = read();
    if (predicate(view)) return view;
    await tick();
  }
  throw new Error(`session never reached the expected state: ${JSON.stringify(read())}`);
}

test("the trusted machine approves and the new machine receives the account's key", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: ACCOUNT } });
  const { recipient, approver } = await sessions(cloud, masterKey);

  // B publishes a request and shows the user a locator to find it by.
  const asked = recipient.view;
  expect(asked.state).toBe("waiting-for-approval");
  expect(asked.locator).toMatch(/^[0-9A-Z]{6}$/);

  // A finds it, and offering is what starts the comparison on both machines.
  const listed = await approver.list();
  expect(listed).toMatchObject([
    { locator: asked.locator, machineName: "B's MacBook" },
  ]);
  const inspected = await approver.inspect(asked.requestId);

  const comparing = await until(
    () => recipient.view,
    (view) => view.state === "comparing",
  );
  expect(inspected.verificationCode).toBe(comparing.verificationCode);

  // The user compares the two codes and approves on A.
  await approver.approve(asked.requestId);

  const done = await until(() => recipient.view, (view) => view.state === "complete");
  expect(done.error).toBeUndefined();
  expect(recipient.key()).toBe(masterKey);
});

test("a key that cannot open the account's documents is refused, not committed", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: ACCOUNT } });
  const delivered: string[] = [];
  const recipient = await startKeyTransferRequest({
    relay: relayFor(cloud),
    machineName: "B's MacBook",
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    // The account's documents are wrapped with a key the approving machine
    // does not have.
    wrappedKeys: wrappedKeysFor(generateTaskKey()),
    sleep: tick,
    onKey: (key) => delivered.push(key),
  });
  const approver = createKeyTransferApproverSession({
    relay: relayFor(cloud),
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    masterKey: generateTaskKey(),
    sleep: tick,
  });

  await approver.inspect(recipient.view.requestId);
  await until(() => recipient.view, (view) => view.state === "comparing");
  await approver.approve(recipient.view.requestId);

  const settled = await until(
    () => recipient.view,
    (view) => view.state === "failed" || view.state === "complete",
  );
  expect(settled.state).toBe("failed");
  expect(settled.error).toContain("could not decrypt");
  expect(recipient.key()).toBeUndefined();
  expect(delivered).toEqual([]);
});

/** A relay that rewrites one field of the records it hands back — the one
 * attack the comparison ceremony exists to catch. */
function tamperingCloud(
  cloud: FakeCloud,
  rewrite: (record: Record<string, unknown>) => void,
): typeof globalThis.fetch {
  const honest = cloud.fetch;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await honest(input, init);
    const { pathname } = new URL(String(input));
    if (!pathname.startsWith("/api/key-transfer") || !response.ok) return response;
    const payload = (await response.json()) as unknown;
    for (const record of Array.isArray(payload) ? payload : [payload]) {
      rewrite(record as Record<string, unknown>);
    }
    return Response.json(payload, { status: response.status });
  }) as typeof globalThis.fetch;
}

test("a relay that substitutes the approving machine's key shows the user two different codes", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: ACCOUNT } });
  const impostor = createKeyTransferApprover({
    protocolVersion: 1,
    requestId: "00000000-0000-4000-8000-000000000000",
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    machineName: "B's MacBook",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    commitment: "x".repeat(43) + "=",
  });

  const recipient = await startKeyTransferRequest({
    relay: createKeyTransferRelay({
      serverUrl: cloud.url,
      // Everything B reads has the attacker's key in place of A's.
      fetch: tamperingCloud(cloud, (record) => {
        if (record.senderPublicKey) record.senderPublicKey = impostor.publicKey;
      }),
      accessToken: "cloud-token",
    }),
    machineName: "B's MacBook",
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    wrappedKeys: wrappedKeysFor(masterKey),
    sleep: tick,
  });
  const approver = createKeyTransferApproverSession({
    relay: relayFor(cloud),
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    masterKey,
    sleep: tick,
  });

  const inspected = await approver.inspect(recipient.view.requestId);
  const comparing = await until(
    () => recipient.view,
    (view) => view.state === "comparing" || view.state === "failed",
  );

  expect(comparing.state).toBe("comparing");
  expect(inspected.verificationCode).not.toBe(comparing.verificationCode);
});

test("a relay that substitutes the requesting machine's key is caught by its commitment", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: ACCOUNT } });
  const stranger = createKeyTransferRecipient();
  const honestB = await startKeyTransferRequest({
    relay: relayFor(cloud),
    machineName: "B's MacBook",
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    wrappedKeys: wrappedKeysFor(generateTaskKey()),
    sleep: tick,
  });
  const approver = createKeyTransferApproverSession({
    relay: createKeyTransferRelay({
      serverUrl: cloud.url,
      fetch: tamperingCloud(cloud, (record) => {
        if (record.recipientPublicKey) {
          record.recipientPublicKey = stranger.acceptOffer(
            String(record.senderPublicKey),
            record as never,
          ).publicKey;
        }
      }),
      accessToken: "cloud-token",
    }),
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    masterKey: generateTaskKey(),
    sleep: tick,
  });

  await expect(approver.inspect(honestB.view.requestId)).rejects.toThrow(
    /committed/,
  );
});

test("a denied request ends the requesting machine's wait with a way forward", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: ACCOUNT } });
  const { recipient, approver } = await sessions(cloud, generateTaskKey());

  await approver.deny(recipient.view.requestId);

  const settled = await until(
    () => recipient.view,
    (view) => view.state !== "waiting-for-approval",
  );
  expect(settled.state).toBe("denied");
  expect(settled.error).toContain("recovery key");
  expect(recipient.key()).toBeUndefined();
});

test("approving a request nobody compared on this machine is refused", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: ACCOUNT } });
  const { recipient, approver } = await sessions(cloud, generateTaskKey());

  await expect(approver.approve(recipient.view.requestId)).rejects.toThrow(
    /compared/,
  );
  const untouched = await relayFor(cloud).read(recipient.view.requestId);
  expect(untouched?.state).toBe("pending");
  expect(untouched?.envelope).toBeUndefined();
});

test("a request cancelled before delivery commits nothing, even if an approval lands", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: ACCOUNT } });
  const delivered: string[] = [];
  const recipient = await startKeyTransferRequest({
    relay: relayFor(cloud),
    machineName: "B's MacBook",
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    wrappedKeys: wrappedKeysFor(masterKey),
    sleep: tick,
    onKey: (key) => delivered.push(key),
  });
  const approver = createKeyTransferApproverSession({
    relay: relayFor(cloud),
    accountId: ACCOUNT,
    serviceOrigin: cloud.url,
    masterKey,
    sleep: tick,
  });

  await approver.inspect(recipient.view.requestId);
  await until(() => recipient.view, (view) => view.state === "comparing");

  // The user gives up here — and the other machine approves anyway.
  await recipient.cancel();
  await approver.approve(recipient.view.requestId).catch(() => undefined);
  for (let poll = 0; poll < 20; poll += 1) await tick();

  expect(recipient.view.state).toBe("cancelled");
  expect(recipient.key()).toBeUndefined();
  expect(delivered).toEqual([]);
});
