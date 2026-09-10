import { expect, test } from "vitest";
import {
  assertKeyTransferContext,
  createKeyTransferApprover,
  createKeyTransferRecipient,
  generateTaskKey,
  keyTransferLocator,
} from "@trace/core";
import { FakeCloud } from "./fake-sync-server.ts";
import { createKeyTransferRelay } from "./key-transfer-relay.ts";

/**
 * The local half of the key-transfer relay: what each machine sends, what it
 * refuses to believe, and what it does when the relay answers oddly.
 *
 * The relay is a hostile courier by assumption, so these tests are as much
 * about the client's suspicion as about the happy path.
 */

function relayFor(cloud: FakeCloud, token = "cloud-token") {
  return createKeyTransferRelay({
    serverUrl: cloud.url,
    fetch: cloud.fetch,
    accessToken: token,
  });
}

test("a machine asks for a transfer and the account's other machine sees it waiting", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  const relay = relayFor(cloud);
  const recipient = createKeyTransferRecipient();

  const created = await relay.create({
    commitment: recipient.commitment,
    machineName: "B's MacBook",
    now: new Date(),
  });

  expect(created.state).toBe("pending");
  expect(created.locator).toBe(keyTransferLocator(created.context.requestId));
  expect(created.context).toMatchObject({
    accountId: "octocat",
    serviceOrigin: cloud.url,
    machineName: "B's MacBook",
    commitment: recipient.commitment,
    protocolVersion: 1,
  });

  const pending = await relayFor(cloud).listPending();
  expect(pending.map((request) => request.context.requestId)).toEqual([
    created.context.requestId,
  ]);
  expect(pending[0]?.locator).toBe(created.locator);
});

test("the two machines complete an exchange and the master key arrives intact", async () => {
  const cloud = new FakeCloud({ token: "cloud-token", user: { id: "octocat" } });
  const master = generateTaskKey();
  const b = relayFor(cloud);
  const a = relayFor(cloud);

  // B: publish a commitment and wait.
  const recipient = createKeyTransferRecipient();
  const created = await b.create({
    commitment: recipient.commitment,
    machineName: "B's MacBook",
    now: new Date(),
  });
  const requestId = created.context.requestId;

  // A: read the request, check it against what it knows locally, offer a key.
  const seen = (await a.listPending())[0]!;
  assertKeyTransferContext(seen.context, {
    accountId: "octocat",
    serviceOrigin: cloud.url,
    now: new Date(),
  });
  const approver = createKeyTransferApprover(seen.context);
  await a.offer(requestId, approver.publicKey);

  // B: take the offer, which is what makes its own key safe to reveal.
  const offered = await b.read(requestId);
  const exchange = recipient.acceptOffer(offered!.senderPublicKey!, offered!.context);
  await b.reveal(requestId, exchange.publicKey);

  // A: check the reveal against the commitment, and show the user a code.
  const revealed = await a.read(requestId);
  const approval = approver.acceptReveal(
    revealed!.recipientPublicKey!,
    revealed!.context,
  );
  expect(approval.verificationCode).toBe(exchange.verificationCode);

  // The user says the codes match; only then is the key sealed.
  await a.approve(requestId, approval.seal(master));

  const delivered = await b.read(requestId);
  expect(exchange.open(delivered!.envelope!)).toBe(master);
  expect((await b.claim(requestId)).state).toBe("claimed");
});
