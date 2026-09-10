import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { generateTaskKey, readSyncIdentity } from "@trace/core";
import { createLocalAuthService } from "./local-auth.ts";
import { createKeyTransferRelay } from "./key-transfer-relay.ts";
import { createKeyTransferApproverSession } from "./key-transfer-session.ts";
import { FakeCloud } from "./fake-sync-server.ts";
import {
  hostedBoard,
  machine as makeMachine,
  machineAWithSyncedWork,
  tick,
  untilView,
  type HostedBoard,
  type Machine,
} from "./second-machine-fixtures.ts";

/**
 * Setting up a second machine is a several-minute interaction across two
 * machines and a browser, so it gets interrupted: the tab is closed, the local
 * service restarts, the first machine is asleep, the approval and the expiry
 * arrive together.
 *
 * What every test here asks is the same question in a different way — after the
 * interruption, does the user get told something true and given something to
 * do? Starting over is an acceptable answer. Waiting forever on a login nobody
 * is running is not.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trace-resume-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type BoardAttempt = {
  attemptId: string;
  state: string;
  error?: string;
  transfer?: {
    requestId: string;
    locator: string;
    state: string;
    verificationCode?: string;
    error?: string;
  };
};

/** A fresh second machine, signed in through its own board as far as the key
 * step — which is where every interruption in this file happens. */
async function machineBAtTheKeyPrompt(
  cloud: FakeCloud,
): Promise<{
  b: Machine;
  board: HostedBoard;
  attemptId: string;
  attempt: () => Promise<BoardAttempt>;
  current: () => Promise<BoardAttempt | null>;
}> {
  const b = makeMachine(root, "b", cloud.url);
  const board = hostedBoard(b, cloud);
  const started = JSON.parse(
    (
      await board.request(
        "POST",
        "/api/local-auth/login",
        JSON.stringify({ provider: "github" }),
      )
    ).body,
  ) as { attemptId: string };
  cloud.approve();
  const attempt = (): Promise<BoardAttempt> =>
    board
      .request("GET", `/api/local-auth/login/${started.attemptId}`)
      .then((response) => JSON.parse(response.body) as BoardAttempt);
  const current = (): Promise<BoardAttempt | null> =>
    board
      .request("GET", "/api/local-auth/login/current")
      .then((response) => JSON.parse(response.body) as BoardAttempt | null);
  await untilView(attempt, (view) => view.state === "waiting-for-existing-key");
  return { b, board, attemptId: started.attemptId, attempt, current };
}

/** Machine A's side of the ceremony, driven directly. */
function approverFor(cloud: FakeCloud, masterKey: string) {
  return createKeyTransferApproverSession({
    relay: createKeyTransferRelay({
      serverUrl: cloud.url,
      fetch: cloud.fetch,
      accessToken: "cloud-token",
    }),
    accountId: "octocat",
    serviceOrigin: cloud.url,
    masterKey,
    sleep: tick,
  });
}

test("reopening the board finds the request the closed tab left waiting", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  await machineAWithSyncedWork(root, cloud, "cloud-token", masterKey);
  const { board, attemptId, attempt, current } = await machineBAtTheKeyPrompt(cloud);

  await board.request("POST", `/api/local-auth/login/${attemptId}/transfer`);
  const asking = await untilView(attempt, (view) => view.transfer !== undefined);
  const locator = asking.transfer?.locator;
  expect(locator).toMatch(/^[0-9A-Z]{6}$/);

  // A joins, so there is a code on screen to compare.
  const approver = approverFor(cloud, masterKey);
  const listed = await approver.list();
  await approver.inspect(listed[0]!.requestId);
  const comparing = await untilView(
    attempt,
    (view) => view.transfer?.state === "comparing",
  );

  // The user closes the tab and opens the board again. It holds no attempt id
  // — that lived in the popover — so it asks the machine what is outstanding,
  // and must get back the request it was in the middle of comparing, not an
  // invitation to start over.
  const reopened = await current();
  expect(reopened).toMatchObject({
    attemptId,
    state: "waiting-for-existing-key",
    transfer: {
      locator,
      state: "comparing",
      verificationCode: comparing.transfer?.verificationCode,
    },
  });

  // And it is the same live request, so approving from A still lands.
  await approver.approve(listed[0]!.requestId);
  await untilView(attempt, (view) => view.state === "complete");
  expect(readSyncIdentity(makeMachine(root, "b", cloud.url).db)).toMatchObject({
    accountId: "octocat",
  });
});

test("a restarted local service abandons the transfer and keeps none of its secrets", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  await machineAWithSyncedWork(root, cloud, "cloud-token", masterKey);
  const { b, board, attemptId, attempt } = await machineBAtTheKeyPrompt(cloud);

  await board.request("POST", `/api/local-auth/login/${attemptId}/transfer`);
  const approver = approverFor(cloud, masterKey);
  const listed = await approver.list();
  await approver.inspect(listed[0]!.requestId);
  await untilView(attempt, (view) => view.transfer?.state === "comparing");

  // `eqnx serve` restarts. Everything the ceremony held — the approved bearer
  // token, the ephemeral private key — was in that process's memory, and this
  // is the assertion that it was only ever there.
  const files = readdirSync(join(b.home, ".trace"));
  expect(files).not.toContain("auth.json");
  expect(files).not.toContain("key.json");
  for (const file of files) {
    expect(readFileSync(join(b.home, ".trace", file), "utf8")).not.toContain(
      masterKey,
    );
  }
  expect(readSyncIdentity(b.db)).toBeNull();

  const restarted = createLocalAuthService(b.env, {
    fetch: cloud.fetch,
    sleep: tick,
  });
  // The honest answer to "what was I in the middle of?" is nothing. A restarted
  // service that claimed the old attempt would be claiming a private key it
  // does not have.
  expect(restarted.readCurrentLogin()).toBeNull();
  expect(restarted.readLogin(attemptId)).toBeNull();

  // And starting over works: the abandoned request is not in anybody's way.
  const fresh = await restarted.startLogin("github");
  await untilView(
    async () => restarted.readLogin(fresh.attemptId),
    (view) => view?.state === "waiting-for-existing-key",
  );
  await restarted.requestKeyTransfer(fresh.attemptId);
  const nowPending = await approver.list();
  expect(nowPending).toHaveLength(1);
  const second = nowPending[0]!.requestId;
  expect(second).not.toBe(listed[0]!.requestId);
  await approver.inspect(second);
  await untilView(
    async () => restarted.readLogin(fresh.attemptId),
    (view) => view?.transfer?.state === "comparing",
  );
  await approver.approve(second);
  await untilView(
    async () => restarted.readLogin(fresh.attemptId),
    (view) => view?.state === "complete",
  );
  expect(readSyncIdentity(b.db)).toMatchObject({ accountId: "octocat" });
});

test("a request that expires while the first machine sleeps leaves the key prompt standing", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  await machineAWithSyncedWork(root, cloud, "cloud-token", masterKey);
  const { b, board, attemptId, attempt } = await machineBAtTheKeyPrompt(cloud);

  await board.request("POST", `/api/local-auth/login/${attemptId}/transfer`);
  await untilView(attempt, (view) => view.transfer !== undefined);

  // Machine A is shut, asleep, or elsewhere. Nobody ever answers.
  cloud.transferClock = () => new Date(Date.now() + 11 * 60 * 1000);
  const expired = await untilView(
    attempt,
    (view) => view.transfer?.state === "expired",
  );

  // The login itself is untouched: waiting on one way in is not the same as
  // failing, and the other way in was on screen the whole time.
  expect(expired.state).toBe("waiting-for-existing-key");
  expect(expired.transfer?.error).toMatch(/recovery key/i);

  const settled = JSON.parse(
    (
      await board.request(
        "POST",
        `/api/local-auth/login/${attemptId}/existing-key`,
        JSON.stringify({ key: masterKey }),
      )
    ).body,
  ) as BoardAttempt;
  expect(settled.state).toBe("complete");
  expect(readSyncIdentity(b.db)).toMatchObject({ accountId: "octocat" });
});

test("giving up on approval and typing the key finishes once, and stops asking", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  await machineAWithSyncedWork(root, cloud, "cloud-token", masterKey);
  const { b, board, attemptId, attempt } = await machineBAtTheKeyPrompt(cloud);

  await board.request("POST", `/api/local-auth/login/${attemptId}/transfer`);
  const approver = approverFor(cloud, masterKey);
  const listed = await approver.list();
  await approver.inspect(listed[0]!.requestId);
  await untilView(attempt, (view) => view.transfer?.state === "comparing");

  // The user gets bored of waiting for A and reaches for their recovery key,
  // which was on the same screen the whole time.
  const settled = JSON.parse(
    (
      await board.request(
        "POST",
        `/api/local-auth/login/${attemptId}/existing-key`,
        JSON.stringify({ key: masterKey }),
      )
    ).body,
  ) as BoardAttempt;
  expect(settled.state).toBe("complete");

  // A is no longer being asked to approve anything.
  expect(await approver.list()).toEqual([]);

  // And the work arrives once, not once per way in.
  await Promise.all(board.syncs);
  expect(board.syncs).toHaveLength(1);
  expect(readSyncIdentity(b.db)).toMatchObject({ accountId: "octocat" });

  // A late approval for the abandoned request cannot re-enter a finished login.
  const after = await approver.inspect(listed[0]!.requestId);
  expect(after.state).toBe("gone");
  expect(board.syncs).toHaveLength(1);
});

test("a wrong recovery key costs the user a retry, not their pairing", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  await machineAWithSyncedWork(root, cloud, "cloud-token", masterKey);
  const { b, board, attemptId } = await machineBAtTheKeyPrompt(cloud);

  const refused = JSON.parse(
    (
      await board.request(
        "POST",
        `/api/local-auth/login/${attemptId}/existing-key`,
        JSON.stringify({ key: generateTaskKey() }),
      )
    ).body,
  ) as BoardAttempt;

  // Still on the prompt, with a reason, and nothing written.
  expect(refused.state).toBe("waiting-for-existing-key");
  expect(refused.error).toBeTruthy();
  expect(readSyncIdentity(b.db)).toBeNull();
  expect(existsSync(join(b.home, ".trace", "auth.json"))).toBe(false);

  // The browser is still paired: a failed sign-in says nothing about whether
  // this browser may talk to this machine.
  const still = await board.request("GET", "/api/local-auth/login/current");
  expect(still.status).toBe(200);

  // And the right key still works, on the same attempt.
  const settled = JSON.parse(
    (
      await board.request(
        "POST",
        `/api/local-auth/login/${attemptId}/existing-key`,
        JSON.stringify({ key: masterKey }),
      )
    ).body,
  ) as BoardAttempt;
  expect(settled.state).toBe("complete");
});

test("a revoked browser cannot go on driving the login it started", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  await machineAWithSyncedWork(root, cloud, "cloud-token", masterKey);
  const { b, board, attemptId } = await machineBAtTheKeyPrompt(cloud);

  board.revoke();

  // Every way this browser had of finishing the login is closed to it, the
  // key prompt above all: pairing is what says this browser may act here, and
  // an approved attempt is not a second authority.
  for (const [method, path, body] of [
    ["GET", `/api/local-auth/login/${attemptId}`, undefined],
    ["GET", "/api/local-auth/login/current", undefined],
    ["POST", `/api/local-auth/login/${attemptId}/existing-key`, JSON.stringify({ key: masterKey })],
    ["POST", `/api/local-auth/login/${attemptId}/transfer`, undefined],
  ] as const) {
    const response = await board.request(method, path, body);
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
  }
  expect(readSyncIdentity(b.db)).toBeNull();

  // The machine itself is untouched: the login is still there for a browser
  // that is allowed to see it.
  expect(board.service.readCurrentLogin()).toMatchObject({
    attemptId,
    state: "waiting-for-existing-key",
  });
});

test("a refused approval ends the wait without ending the sign-in", async () => {
  const masterKey = generateTaskKey();
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  await machineAWithSyncedWork(root, cloud, "cloud-token", masterKey);
  const { b, board, attemptId, attempt } = await machineBAtTheKeyPrompt(cloud);

  await board.request("POST", `/api/local-auth/login/${attemptId}/transfer`);
  const approver = approverFor(cloud, masterKey);
  const listed = await approver.list();
  await approver.inspect(listed[0]!.requestId);
  await untilView(attempt, (view) => view.transfer?.state === "comparing");

  // The codes did not match, or the user did not recognise the machine.
  await approver.deny(listed[0]!.requestId);

  const denied = await untilView(
    attempt,
    (view) => view.transfer?.state === "denied",
  );
  expect(denied.state).toBe("waiting-for-existing-key");
  expect(denied.transfer?.error).toMatch(/recovery key/i);
  expect(readSyncIdentity(b.db)).toBeNull();

  // Nothing was committed on the way past, and the key still works.
  const settled = JSON.parse(
    (
      await board.request(
        "POST",
        `/api/local-auth/login/${attemptId}/existing-key`,
        JSON.stringify({ key: masterKey }),
      )
    ).body,
  ) as BoardAttempt;
  expect(settled.state).toBe("complete");
  await Promise.all(board.syncs);
  expect(board.syncs).toHaveLength(1);
});
