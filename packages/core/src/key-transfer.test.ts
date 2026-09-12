import { describe, expect, test } from "vitest";
import { createKeyWrapper, generateTaskKey } from "./doc-crypto.ts";
import {
  assertKeyTransferContext,
  createKeyTransferApprover,
  createKeyTransferRecipient,
  KEY_TRANSFER_MAX_LIFETIME_MS,
  KEY_TRANSFER_PROTOCOL_VERSION,
  keyTransferLocator,
  type KeyTransferRequestContext,
} from "./key-transfer.ts";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const EXPIRES_AT = "2026-09-10T12:05:00.000Z";

function context(
  overrides: Partial<KeyTransferRequestContext> = {},
): KeyTransferRequestContext {
  return {
    protocolVersion: KEY_TRANSFER_PROTOCOL_VERSION,
    requestId: "5f2b0a6e-1c33-4f5a-9d21-0b7c8e6a4d10",
    accountId: "usr_01H8XK",
    serviceOrigin: "https://sync.example.com",
    machineName: "Ariel's laptop",
    expiresAt: EXPIRES_AT,
    commitment: "",
    ...overrides,
  };
}

/** One honest run of the ceremony, in the order the relay must carry it. */
function ceremony(overrides: Partial<KeyTransferRequestContext> = {}) {
  const recipient = createKeyTransferRecipient();
  const shared = context({ commitment: recipient.commitment, ...overrides });
  const approver = createKeyTransferApprover(shared);
  const exchange = recipient.acceptOffer(approver.publicKey, shared);
  const approval = approver.acceptReveal(exchange.publicKey, shared);
  return { shared, approver, exchange, approval };
}

describe("the commitment ceremony", () => {
  test("carries the master key from the approving machine to the new one", () => {
    const masterKey = generateTaskKey();
    const recipient = createKeyTransferRecipient();
    const shared = context({ commitment: recipient.commitment });

    // A offers its ephemeral key without yet knowing B's.
    const approver = createKeyTransferApprover(shared);
    // Only now does B's public key exist publicly, and only now can B show a
    // code — which is exactly what leaves the relay one blind guess.
    const exchange = recipient.acceptOffer(approver.publicKey, shared);
    const approval = approver.acceptReveal(exchange.publicKey, shared);

    expect(approval.verificationCode).toBe(exchange.verificationCode);
    expect(exchange.open(approval.seal(masterKey))).toBe(masterKey);
  });

  test("hands over a key the account's own wrapped keys accept", () => {
    // The end of the journey: what B opens must be the key that unwraps this
    // account's task keys, or the transfer has achieved nothing.
    const masterKey = generateTaskKey();
    const taskKey = generateTaskKey();
    const wrapped = createKeyWrapper(masterKey).wrapTaskKey(taskKey);
    const { exchange, approval } = ceremony();

    const received = exchange.open(approval.seal(masterKey));

    expect(createKeyWrapper(received).unwrapTaskKey(wrapped)).toBe(taskKey);
  });

  test("commits to the recipient's key without publishing it", () => {
    const recipient = createKeyTransferRecipient();
    const shared = context({ commitment: recipient.commitment });
    const approver = createKeyTransferApprover(shared);

    // Whatever the relay stores at creation time, the recipient's public key is
    // not in it — it does not exist outside the process until an offer arrives.
    expect(recipient.commitment).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(recipient).not.toHaveProperty("publicKey");
    expect(recipient.acceptOffer(approver.publicKey, shared).publicKey).not.toBe(
      recipient.commitment,
    );
  });

  test("refuses an offer carrying back a commitment the machine never made", () => {
    const recipient = createKeyTransferRecipient();
    const impostor = createKeyTransferRecipient();
    const shared = context({ commitment: impostor.commitment });
    const approver = createKeyTransferApprover(shared);

    expect(() =>
      recipient.acceptOffer(
        approver.publicKey,
        context({ commitment: impostor.commitment }),
      ),
    ).toThrow(/committed to/i);
  });

  test("refuses a revealed key that is not the one committed to", () => {
    const recipient = createKeyTransferRecipient();
    const substitute = createKeyTransferRecipient();
    const shared = context({ commitment: recipient.commitment });
    const approver = createKeyTransferApprover(shared);
    const substituted = substitute.acceptOffer(approver.publicKey, {
      ...shared,
      commitment: substitute.commitment,
    });

    // The relay's substitution at reveal time is caught by arithmetic, before
    // the user is asked anything at all.
    expect(() => approver.acceptReveal(substituted.publicKey, shared)).toThrow(
      /committed to/i,
    );
  });

  test("refuses keys that are not X25519", () => {
    const recipient = createKeyTransferRecipient();
    const shared = context({ commitment: recipient.commitment });

    expect(() => recipient.acceptOffer("bm90LWEta2V5", shared)).toThrow(
      /not a usable X25519 key/i,
    );
  });
});

describe("an actively malicious relay", () => {
  test("shows the two machines different codes when it substitutes both keys", () => {
    // The strongest position the relay can take: its own exchange with each
    // machine, and any request fields it likes on either side.
    const b = createKeyTransferRecipient();
    const relayToA = createKeyTransferRecipient();

    const seenByA = context({ commitment: relayToA.commitment });
    const seenByB = context({ commitment: b.commitment });
    const relayToB = createKeyTransferApprover(seenByB);
    const a = createKeyTransferApprover(seenByA);

    const relayExchange = relayToA.acceptOffer(a.publicKey, seenByA);
    const onA = a.acceptReveal(relayExchange.publicKey, seenByA);
    const onB = b.acceptOffer(relayToB.publicKey, seenByB);

    expect(onB.verificationCode).not.toBe(onA.verificationCode);
  });

  test("gets no key out of an approval the user compared and refused", () => {
    const masterKey = generateTaskKey();
    const b = createKeyTransferRecipient();
    const relayToA = createKeyTransferRecipient();
    const seenByA = context({ commitment: relayToA.commitment });
    const seenByB = context({ commitment: b.commitment });
    const relayToB = createKeyTransferApprover(seenByB);
    const a = createKeyTransferApprover(seenByA);

    const relayExchange = relayToA.acceptOffer(a.publicKey, seenByA);
    const onA = a.acceptReveal(relayExchange.publicKey, seenByA);
    const onB = b.acceptOffer(relayToB.publicKey, seenByB);

    // The comparison is the gate: a mismatch means `seal` is never called, so
    // the relay's exchange with A never carries anything.
    expect(onA.verificationCode).not.toBe(onB.verificationCode);
    // And even if the user were tricked into approving, the envelope the relay
    // could forward is one B cannot open — it was sealed to the relay's key.
    expect(() => onB.open(onA.seal(masterKey))).toThrow(/could not be opened/i);
  });

  test("cannot use repeated offers as a code-grinding oracle", () => {
    const recipient = createKeyTransferRecipient();
    const shared = context({ commitment: recipient.commitment });
    const first = createKeyTransferApprover(shared);
    const exchange = recipient.acceptOffer(first.publicKey, shared);
    expect(exchange.verificationCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    for (let i = 0; i < 64; i++) {
      const substitute = createKeyTransferApprover(shared);
      expect(() => recipient.acceptOffer(substitute.publicKey, shared)).toThrow(/already accepted/);
    }
  });

  test("cannot lift an envelope from one exchange onto another", () => {
    const masterKey = generateTaskKey();
    const first = ceremony();
    const second = ceremony();

    expect(() => first.exchange.open(second.approval.seal(masterKey))).toThrow(
      /could not be opened/i,
    );
  });

  test("cannot replace the approving machine's key on a sealed envelope", () => {
    const masterKey = generateTaskKey();
    const { exchange, approval, shared } = ceremony();
    const other = createKeyTransferApprover(shared);
    const envelope = approval.seal(masterKey);

    expect(() =>
      exchange.open({ ...envelope, senderPublicKey: other.publicKey }),
    ).toThrow(/could not be opened/i);
    expect(shared.machineName).toBe("Ariel's laptop");
  });

  test("cannot alter a single byte of the ciphertext", () => {
    const { exchange, approval } = ceremony();
    const envelope = approval.seal(generateTaskKey());
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0x01, bytes.length - 1);

    expect(() =>
      exchange.open({ ...envelope, ciphertext: bytes.toString("base64") }),
    ).toThrow(/could not be opened/i);
  });

  test("never sees the master key in what it stores", () => {
    const masterKey = generateTaskKey();
    const { approval, shared, exchange } = ceremony();

    const relayRecord = JSON.stringify({
      ...shared,
      recipientPublicKey: exchange.publicKey,
      envelope: approval.seal(masterKey),
    });

    expect(relayRecord).not.toContain(masterKey);
    expect(relayRecord).not.toContain(approval.verificationCode);
  });

  test("uses fresh encryption nonces when sealing an envelope", () => {
    const masterKey = generateTaskKey();
    const { approval } = ceremony();

    expect(approval.seal(masterKey).ciphertext).not.toBe(
      approval.seal(masterKey).ciphertext,
    );
  });
});

describe("the request each machine agrees to take part in", () => {
  test("must be this account's, on this service, under a version this machine speaks", () => {
    const expected = {
      accountId: "usr_01H8XK",
      serviceOrigin: "https://sync.example.com",
      now: NOW,
    };

    expect(() => assertKeyTransferContext(ceremony().shared, expected)).not.toThrow();
    expect(() =>
      assertKeyTransferContext(ceremony({ accountId: "someone-else" }).shared, expected),
    ).toThrow(/different account/i);
    expect(() =>
      assertKeyTransferContext(
        ceremony({ serviceOrigin: "https://elsewhere.example.com" }).shared,
        expected,
      ),
    ).toThrow(/different EQNX service/i);
    expect(() =>
      assertKeyTransferContext(ceremony({ protocolVersion: 99 }).shared, expected),
    ).toThrow(/v99/);
  });

  test("must expire, on this machine's clock rather than the relay's arithmetic", () => {
    const expected = {
      accountId: "usr_01H8XK",
      serviceOrigin: "https://sync.example.com",
      now: NOW,
    };

    expect(() =>
      assertKeyTransferContext(
        ceremony({ expiresAt: "2026-09-10T11:59:59.000Z" }).shared,
        expected,
      ),
    ).toThrow(/expired/i);
    // A relay cannot buy itself a longer window by writing a later date on it.
    expect(() =>
      assertKeyTransferContext(
        ceremony({
          expiresAt: new Date(
            NOW.getTime() + KEY_TRANSFER_MAX_LIFETIME_MS + 1000,
          ).toISOString(),
        }).shared,
        expected,
      ),
    ).toThrow(/longer than this machine allows/i);
    expect(() =>
      assertKeyTransferContext(ceremony({ expiresAt: "whenever" }).shared, expected),
    ).toThrow(/no usable expiry/i);
  });

  test("must be shaped like a request, in every field a surface will show", () => {
    const recipient = createKeyTransferRecipient();
    const shared = context({ commitment: recipient.commitment });
    const approver = createKeyTransferApprover(shared);
    const offer = (overrides: Partial<KeyTransferRequestContext>) => () =>
      recipient.acceptOffer(
        approver.publicKey,
        context({ commitment: recipient.commitment, ...overrides }),
      );

    expect(offer({ machineName: "" })).toThrow(/missing its machineName/);
    expect(offer({ machineName: "x".repeat(500) })).toThrow(/implausibly long/);
    expect(offer({ machineName: "Ariel \nlaptop" })).toThrow(/characters it may not/);
    expect(offer({ commitment: "c2hvcnQ=" })).toThrow(/not a SHA-256 digest/);
  });
});

describe("the request locator", () => {
  test("is derived from the request id, so both machines show the same one", () => {
    expect(keyTransferLocator("5f2b0a6e-1c33-4f5a-9d21-0b7c8e6a4d10")).toBe(
      keyTransferLocator("5f2b0a6e-1c33-4f5a-9d21-0b7c8e6a4d10"),
    );
    expect(keyTransferLocator("a")).not.toBe(keyTransferLocator("b"));
  });

  test("is shorter than the verification code, and never mistakable for it", () => {
    const locator = keyTransferLocator("5f2b0a6e-1c33-4f5a-9d21-0b7c8e6a4d10");

    expect(locator).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(locator).not.toContain("-");
  });

  test("is not the verification code for the same request", () => {
    // Only one of the two authenticates anything, and a surface that had them
    // both to hand must never be able to show whichever it reached first.
    const { exchange, shared } = ceremony();

    expect(exchange.verificationCode).toMatch(
      /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/,
    );
    expect(exchange.verificationCode.replace("-", "")).not.toContain(
      keyTransferLocator(shared.requestId),
    );
  });
});

test("a recipient refuses a new offer after revealing its committed key", () => {
  const recipient = createKeyTransferRecipient();
  const shared = context({ commitment: recipient.commitment });
  const first = createKeyTransferApprover(shared);
  const second = createKeyTransferApprover(shared);
  const exchange = recipient.acceptOffer(first.publicKey, shared);
  expect(recipient.acceptOffer(first.publicKey, shared)).toEqual(exchange);
  expect(() => recipient.acceptOffer(second.publicKey, shared)).toThrow(/already|different offer/i);
});

test("an approver fixes the transcript before publishing its offered key", () => {
  const recipient = createKeyTransferRecipient();
  const original = context({ commitment: recipient.commitment });
  const approver = createKeyTransferApprover(original);
  const changed = { ...original, machineName: "Changed after offer" };
  const exchange = recipient.acceptOffer(approver.publicKey, changed);
  expect(() => approver.acceptReveal(exchange.publicKey, changed)).toThrow(/context|transcript/i);
});
