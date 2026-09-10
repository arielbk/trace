import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

/**
 * Moving an account's document encryption key from a machine that has it to a
 * machine that does not, across a relay that is assumed hostile.
 *
 * The construction and — more importantly — the reasoning behind it live in
 * `docs/key-transfer-protocol.md`. The short version: the new machine publishes
 * a *hash commitment* to an ephemeral X25519 key before the approving machine
 * offers its own, both sides derive a short authentication string from the
 * resulting shared secret, and the user compares the two. The commitment is
 * what makes that comparison worth anything: a relay must choose the keys it
 * substitutes before it can compute either code, so it gets one blind guess
 * rather than an offline search.
 *
 * The ordering that argument depends on is enforced by the shapes here, not by
 * the callers: there is no way to obtain the recipient's public key without
 * first handing it the sender's, and no way to obtain a verification code
 * without both.
 *
 * Nothing in this module touches the network, the filesystem, or the relay's
 * state machine. It is the arithmetic; the local services are the ceremony.
 */

export const KEY_TRANSFER_PROTOCOL_VERSION = 1;

/**
 * How a transfer request in flight is described to a board — and, by omission,
 * what a board never sees: no private key, no envelope, no master key. Lives
 * here rather than beside the local service so the API contract in
 * `local-auth-api.ts` can name it without depending on the CLI.
 */
export type KeyTransferRequestState =
  | "waiting-for-approval"
  | "comparing"
  | "complete"
  | "denied"
  | "cancelled"
  | "expired"
  | "failed";

/** One of this account's waiting requests, as the approving machine lists it. */
export interface PendingKeyTransfer {
  requestId: string;
  locator: string;
  machineName: string;
  expiresAt: string;
}

/**
 * What the approving machine shows the user before they decide: which machine
 * is asking, and — once it has revealed the key it committed to — the code
 * that must match the one on its screen.
 */
export interface KeyTransferInspection {
  requestId: string;
  locator: string;
  machineName: string;
  verificationCode?: string;
  state: "waiting-for-reveal" | "comparing" | "gone";
}

export interface KeyTransferRequestView {
  requestId: string;
  /** The short handle for finding this request on the other machine. Not a
   * secret, and never an authenticator — see {@link keyTransferLocator}. */
  locator: string;
  machineName: string;
  state: KeyTransferRequestState;
  /** The code the user must see matching on both machines before approving.
   * Present only while there is something to compare. */
  verificationCode?: string;
  error?: string;
}

/** The longest a request may live, enforced by each machine against its own
 * clock rather than against the relay's arithmetic. */
export const KEY_TRANSFER_MAX_LIFETIME_MS = 10 * 60 * 1000;

const TRANSCRIPT_PREFIX = "trace-key-transfer:v1";
const COMMITMENT_INFO = "trace-key-transfer:commitment:v1";
const ENVELOPE_INFO = "trace-key-transfer:envelope:v1";
const VERIFICATION_INFO = "trace-key-transfer:verification-code:v1";
const LOCATOR_INFO = "trace-key-transfer:request-locator:v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_FIELD_LENGTH = 200;
// Control characters are exactly what this must match: a transcript field
// carrying a newline or a NUL could otherwise be split or padded into looking
// like a different field to one of the two machines.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The request as both machines must see it. Every field is bound into the
 * verification code, the derived key, and the envelope's additional data, so a
 * relay that alters any one of them shows the user two different codes.
 *
 * These are *relay-carried* values. Reading them is not believing them: a
 * machine checks them against what it knows locally through
 * {@link assertKeyTransferContext} before it takes part.
 */
export interface KeyTransferRequestContext {
  protocolVersion: number;
  requestId: string;
  /** The account the relay says both machines are signed into. */
  accountId: string;
  /** The sync service origin this request belongs to, as each machine has it
   * configured locally. A request relayed by a different deployment than the
   * one this machine is signed into is not this machine's request. */
  serviceOrigin: string;
  /** The descriptive name the requesting machine gave itself. Bound so a relay
   * cannot swap the labels of two concurrent requests; it proves nothing about
   * which machine is which on its own. */
  machineName: string;
  /** ISO-8601 instant after which no machine will take part. */
  expiresAt: string;
  /** Base64 SHA-256 commitment to the recipient's ephemeral public key. */
  commitment: string;
}

/** What the relay carries, and all it carries. */
export interface KeyTransferEnvelope {
  /** Base64 SPKI DER of the approving machine's ephemeral X25519 public key. */
  senderPublicKey: string;
  /** Base64 AES-256-GCM envelope over the master key. */
  ciphertext: string;
}

/** The new machine, between publishing its commitment and receiving an offer. */
export interface KeyTransferRecipient {
  /** Published when the request is created. The only thing this machine
   * publishes before the approving machine has committed to its own key. */
  commitment: string;
  /**
   * Take the approving machine's offered public key, which is what finally
   * makes this machine's own public key and verification code exist.
   *
   * Throws when the context is malformed, or when the commitment the relay
   * echoed back is not the one this machine published.
   */
  acceptOffer(
    senderPublicKey: string,
    context: KeyTransferRequestContext,
  ): KeyTransferExchange;
}

/** The new machine, once the exchange is joined. */
export interface KeyTransferExchange {
  /** Base64 SPKI DER of this machine's ephemeral key, now safe to reveal. */
  publicKey: string;
  /** The code the user reads off this machine and compares against the other. */
  verificationCode: string;
  /** Open an approved envelope, returning the master key in canonical hex.
   * Throws for every failure alike — a substituted key, an altered context, a
   * tampered ciphertext — because the distinction is not one this side can make
   * honestly, and a relay must not learn which of its guesses was closer. */
  open(envelope: KeyTransferEnvelope): string;
}

/** The trusted machine, between reading a request and seeing the reveal. */
export interface KeyTransferApprover {
  /** Base64 SPKI DER of this machine's ephemeral key, offered to the relay. */
  publicKey: string;
  /**
   * Take the recipient's revealed public key, checking it against the
   * commitment carried in the request. Throws when it does not match: a relay
   * that substitutes a key here is caught by arithmetic rather than by the
   * user, and there is nothing to show them.
   */
  acceptReveal(
    recipientPublicKey: string,
    context: KeyTransferRequestContext,
  ): KeyTransferApproval;
}

/** The trusted machine, once it has everything but the user's word. */
export interface KeyTransferApproval {
  /** The code to show the user, who must confirm it matches the other machine's
   * before {@link seal} is ever called. */
  verificationCode: string;
  /** Seal this account's master key for the recipient. */
  seal(masterKeyHex: string): KeyTransferEnvelope;
}

export const KEY_TRANSFER_OPEN_FAILURE =
  "The approved key could not be opened on this machine. Check that the codes matched, and try again.";

export const KEY_TRANSFER_COMMITMENT_MISMATCH =
  "That machine's key does not match the one it committed to when it asked. Cancel the request and start again.";

/**
 * Mint the ephemeral identity a machine requests a transfer under.
 *
 * The private key is held by the returned closures and by nothing else: it
 * never leaves the process, is never written down, and dies with the request. A
 * restart therefore abandons the transfer rather than resuming it, which is the
 * behaviour we want — persisting it to survive an interruption would trade the
 * one property that makes the relay safe to use for a nicety.
 */
export function createKeyTransferRecipient(): KeyTransferRecipient {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const encoded = exportPublicKey(publicKey);
  const commitment = commitTo(encoded);
  let accepted: { transcript: Buffer; exchange: KeyTransferExchange } | undefined;

  return {
    commitment,
    acceptOffer(senderPublicKey, context) {
      assertContextShape(context);
      // The relay carries our own commitment back to us; a different one means
      // the request the other machine is looking at is not the one we made.
      if (!sameCommitment(context.commitment, commitment)) {
        throw new Error(KEY_TRANSFER_COMMITMENT_MISMATCH);
      }
      const sender = importPeerPublicKey(senderPublicKey);
      const transcript = transcriptBytes(context, senderPublicKey, encoded);
      if (accepted) {
        if (!accepted.transcript.equals(transcript)) throw new Error("This recipient already accepted a different offer or request context. Start a new transfer.");
        return accepted.exchange;
      }
      const shared = agree(privateKey, sender);

      const exchange: KeyTransferExchange = {
        publicKey: encoded,
        verificationCode: verificationCode(shared, transcript),
        open(envelope) {
          try {
            // The envelope must come from the key we joined the exchange with:
            // a second approval under a different sender key is a different
            // exchange, and one the user never compared a code for.
            if (envelope.senderPublicKey !== senderPublicKey) {
              throw new Error("envelope is from a different exchange");
            }
            return parseMasterKey(
              open(
                envelopeKey(shared, transcript),
                Buffer.from(envelope.ciphertext, "base64"),
                transcript,
              ),
            );
          } catch {
            throw new Error(KEY_TRANSFER_OPEN_FAILURE);
          }
        },
      };
      accepted = { transcript, exchange };
      return exchange;
    },
  };
}

/**
 * Mint the ephemeral identity the approving machine offers.
 *
 * Offered before the recipient's key is revealed, which is the half of the
 * ordering the commitment does not cover: neither machine's key is chosen with
 * knowledge of the other's, so neither code can be steered.
 */
export function createKeyTransferApprover(request: KeyTransferRequestContext): KeyTransferApprover {
  assertContextShape(request);
  const pinned = structuredClone(request);
  const pinnedTranscript = transcriptBytes(pinned, "", "");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const encoded = exportPublicKey(publicKey);

  return {
    publicKey: encoded,
    acceptReveal(recipientPublicKey, context) {
      assertContextShape(context);
      if (!pinnedTranscript.equals(transcriptBytes(context, "", ""))) {
        throw new Error("The request context changed after this machine published its offer.");
      }
      if (!sameCommitment(context.commitment, commitTo(recipientPublicKey))) {
        throw new Error(KEY_TRANSFER_COMMITMENT_MISMATCH);
      }
      const recipient = importPeerPublicKey(recipientPublicKey);
      const transcript = transcriptBytes(context, encoded, recipientPublicKey);
      const shared = agree(privateKey, recipient);

      return {
        verificationCode: verificationCode(shared, transcript),
        seal(masterKeyHex) {
          const master = parseMasterKeyHex(masterKeyHex);
          return {
            senderPublicKey: encoded,
            ciphertext: Buffer.from(
              seal(envelopeKey(shared, transcript), master, transcript),
            ).toString("base64"),
          };
        },
      };
    },
  };
}

/**
 * What each machine must check against what it knows locally, before it shows
 * the user anything or takes part in the exchange.
 *
 * The context arrives from the relay, so believing its `accountId`,
 * `serviceOrigin` or `expiresAt` would be believing the adversary. `expiresAt`
 * in particular is checked twice over: it must be in this machine's future, and
 * it must not claim a lifetime longer than this machine allows — a relay cannot
 * extend a request's life by writing a later date on it.
 */
export function assertKeyTransferContext(
  context: KeyTransferRequestContext,
  expected: {
    accountId: string;
    serviceOrigin: string;
    now: Date;
    protocolVersion?: number;
  },
): void {
  assertContextShape(context);
  const version = expected.protocolVersion ?? KEY_TRANSFER_PROTOCOL_VERSION;
  if (context.protocolVersion !== version) {
    throw new Error(
      `This request uses key transfer protocol v${context.protocolVersion}, and this machine speaks v${version}. Update EQNX on both machines.`,
    );
  }
  if (context.accountId !== expected.accountId) {
    throw new Error("That request belongs to a different account.");
  }
  if (context.serviceOrigin !== expected.serviceOrigin) {
    throw new Error("That request belongs to a different EQNX service.");
  }
  const expiresAt = Date.parse(context.expiresAt);
  if (Number.isNaN(expiresAt)) throw new Error("That request has no usable expiry.");
  const remaining = expiresAt - expected.now.getTime();
  if (remaining <= 0) throw new Error("That request has expired. Start a new one.");
  if (remaining > KEY_TRANSFER_MAX_LIFETIME_MS) {
    throw new Error("That request claims to last longer than this machine allows.");
  }
}

/**
 * A short handle for finding this request among an account's pending ones.
 *
 * Deliberately not a secret and deliberately not the verification code: it
 * answers "which of these rows is the machine in front of me", and authorizing
 * on it would authorize on a value the relay chose. It is derived through its
 * own label so no surface can ever show one where the other belongs.
 */
export function keyTransferLocator(requestId: string): string {
  return encodeBase32(
    Buffer.from(
      hkdfSync("sha256", Buffer.from(requestId, "utf8"), Buffer.alloc(0), LOCATOR_INFO, 4),
    ),
    6,
  );
}

/** SHA-256 over a public key, domain-separated so a commitment can never be
 * mistaken for any other digest in the protocol. */
function commitTo(publicKey: string): string {
  return createHash("sha256")
    .update(`${COMMITMENT_INFO}\n${publicKey}`, "utf8")
    .digest("base64");
}

function sameCommitment(carried: string, expected: string): boolean {
  const a = Buffer.from(carried, "base64");
  const b = Buffer.from(expected, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The verification code both machines display: 40 bits of the shared secret and
 * the transcript, in a Crockford base32 alphabet (no I, L, O or U to misread),
 * split into two groups of four so it can be read aloud without losing place.
 *
 * Derived from the *shared secret* rather than from the request alone. That is
 * what the commitment buys: a relay that substitutes keys must fix both of its
 * own before it can learn either machine's secret, so it cannot search for a
 * pair that collides — it commits, and then it is right or it is seen.
 */
function verificationCode(shared: Buffer, transcript: Buffer): string {
  const digits = encodeBase32(
    Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        createHash("sha256").update(transcript).digest(),
        VERIFICATION_INFO,
        5,
      ),
    ),
    8,
  );
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/**
 * The per-request AES key. The transcript digest is the HKDF salt, so two
 * machines that disagree about any field of the request derive different keys
 * even when the ECDH itself succeeded.
 */
function envelopeKey(shared: Buffer, transcript: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      createHash("sha256").update(transcript).digest(),
      ENVELOPE_INFO,
      32,
    ),
  );
}

function agree(ourPrivateKey: KeyObject, theirPublicKey: KeyObject): Buffer {
  return diffieHellman({ privateKey: ourPrivateKey, publicKey: theirPublicKey });
}

/**
 * The canonical transcript bytes: every field length-prefixed, so no two
 * different requests can ever produce the same bytes. Joining with a separator
 * would leave the question of what a field containing that separator means;
 * length prefixes leave no question to answer.
 */
function transcriptBytes(
  context: KeyTransferRequestContext,
  senderPublicKey: string,
  recipientPublicKey: string,
): Buffer {
  return Buffer.concat(
    [
      TRANSCRIPT_PREFIX,
      String(context.protocolVersion),
      context.requestId,
      context.accountId,
      context.serviceOrigin,
      context.machineName,
      context.expiresAt,
      context.commitment,
      senderPublicKey,
      recipientPublicKey,
    ].map(framed),
  );
}

function framed(field: string): Buffer {
  const bytes = Buffer.from(field, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * What must be true of a relay-carried context before any of it is used or
 * shown. Nothing here is a security boundary on its own — the codes are — but a
 * field that is the wrong shape is a field no user can meaningfully compare,
 * and an unbounded one is a field that can wreck the surface displaying it.
 */
function assertContextShape(context: KeyTransferRequestContext): void {
  if (!Number.isInteger(context.protocolVersion) || context.protocolVersion < 1) {
    throw new Error("That request does not name a usable protocol version.");
  }
  for (const [name, value] of [
    ["requestId", context.requestId],
    ["accountId", context.accountId],
    ["serviceOrigin", context.serviceOrigin],
    ["machineName", context.machineName],
    ["expiresAt", context.expiresAt],
    ["commitment", context.commitment],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`That request is missing its ${name}.`);
    }
    if (value.length > MAX_FIELD_LENGTH) {
      throw new Error(`That request's ${name} is implausibly long.`);
    }
    // Control characters have no business in any of these fields: every one of
    // them is either an identifier or something a user has to read.
    if (CONTROL_CHARACTERS.test(value)) {
      throw new Error(`That request's ${name} contains characters it may not.`);
    }
  }
  if (Buffer.from(context.commitment, "base64").length !== 32) {
    throw new Error("That request's commitment is not a SHA-256 digest.");
  }
}

function exportPublicKey(key: KeyObject): string {
  return key.export({ type: "spki", format: "der" }).toString("base64");
}

/**
 * Read a peer's public key, refusing anything that is not X25519. Without the
 * algorithm check a relay could offer a key on another curve and steer the
 * exchange somewhere neither machine agreed to.
 */
function importPeerPublicKey(encoded: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.from(encoded, "base64"),
      type: "spki",
      format: "der",
    });
  } catch {
    throw new Error("That machine's key is not a usable X25519 key.");
  }
  if (key.asymmetricKeyType !== "x25519") {
    throw new Error("That machine's key is not a usable X25519 key.");
  }
  return key;
}

function parseMasterKeyHex(masterKeyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    throw new Error("document encryption key must be 64 hexadecimal characters");
  }
  return Buffer.from(masterKeyHex, "hex");
}

function parseMasterKey(plaintext: Uint8Array): string {
  if (plaintext.length !== 32) throw new Error("transferred key has the wrong length");
  return Buffer.from(plaintext).toString("hex");
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
}

function open(key: Buffer, envelope: Buffer, aad: Buffer): Uint8Array {
  if (envelope.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("key transfer envelope is truncated");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    envelope.subarray(0, NONCE_BYTES),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(envelope.subarray(-TAG_BYTES));
  return new Uint8Array(
    Buffer.concat([
      decipher.update(envelope.subarray(NONCE_BYTES, -TAG_BYTES)),
      decipher.final(),
    ]),
  );
}

/** Crockford base32: no I, L, O or U, so nothing in a code read over a desk can
 * be confused with a digit or with another letter. */
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(bytes: Buffer, digits: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < digits) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  return out.padEnd(digits, BASE32_ALPHABET[0]);
}
