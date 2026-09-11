import { randomUUID } from "node:crypto";
import {
  assertKeyTransferContext,
  createKeyTransferApprover,
  createKeyTransferRecipient,
  KEY_TRANSFER_MAX_LIFETIME_MS,
  type KeyTransferExchange,
  type KeyTransferInspection,
  type KeyTransferRequestState,
  type KeyTransferRequestView,
  type PendingKeyTransfer,
  type KeyTransferRequestContext,
  type SyncWrappedKey,
} from "@trace/core";
import { validateDocumentKey } from "./auth-service.ts";
import {
  KEY_TRANSFER_EXPIRED_MESSAGE,
  KeyTransferConflictError,
  KeyTransferExpiredError,
  KeyTransferUnavailableError,
  type KeyTransferRecord,
  type KeyTransferRelay,
} from "./key-transfer-relay.ts";

/**
 * The ceremony each machine runs around `@trace/core`'s key-transfer
 * arithmetic: one session for the machine asking to be let in, one for the
 * machine that can let it in.
 *
 * Both hold their ephemeral private key in process memory and nowhere else, so
 * restarting the local service abandons a transfer rather than resuming it —
 * see `docs/key-transfer-protocol.md`. Both also check their own clock against
 * a deadline pinned at the start: a relay cannot keep an attempt alive by
 * writing a later expiry on it.
 */

export interface KeyTransferRequestSession {
  readonly view: KeyTransferRequestView;
  /** The account's master key, once it has been delivered *and* proven against
   * the account's own wrapped keys. `undefined` at every other moment. */
  key(): string | undefined;
  /** Abandon the request, here and on the relay. */
  cancel(): Promise<void>;
}

export const KEY_TRANSFER_DENIED_MESSAGE =
  "The other machine declined this request. Try again, or use your recovery key.";

export const KEY_TRANSFER_GONE_MESSAGE =
  "This transfer request is no longer available. Start a new one, or use your recovery key.";

/** How long a machine waits between polls of the relay. */
const POLL_INTERVAL_MS = 1_000;

/** How many of those polls one `inspect` call is willing to spend before
 * answering "still waiting" and letting the board ask again. */
const INSPECT_POLLS = 5;

/**
 * How many relay reads in a row may come back as nothing at all before a
 * machine stops waiting.
 *
 * A dropped response is not evidence about the request — the row is on the
 * relay either way — so one is worth another poll rather than the end of the
 * ceremony. A run of them is a connection that will not come back inside this
 * interaction, and saying so beats leaving the user comparing a code against a
 * machine nobody is talking to.
 */
const MAX_READ_FAILURES = 5;

export const KEY_TRANSFER_UNREACHABLE_MESSAGE =
  "This machine lost contact with the sync server while it waited. Ask again, or use your recovery key.";

/** A relay that stopped answering — told apart from one that answered with a
 * refusal, which is a fact about the request rather than about the network. */
export class KeyTransferUnreachableError extends Error {
  constructor() {
    super(KEY_TRANSFER_UNREACHABLE_MESSAGE);
  }
}

export const KEY_TRANSFER_NOT_STORED_MESSAGE =
  "The key arrived, but this machine could not store it. Fix the local storage problem, then sign in again.";

/**
 * Wait between polls, and hand the event loop a turn either way.
 *
 * The extra turn matters when the injected sleep resolves immediately: a loop
 * that only ever awaits already-settled promises starves timers and other
 * work on the same thread, which would make this poll loop a way to wedge the
 * local service rather than merely a slow one.
 */
function pauser(
  sleep: (milliseconds: number) => Promise<void>,
): () => Promise<void> {
  return async () => {
    await sleep(POLL_INTERVAL_MS);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  };
}

/**
 * Run a relay write that is safe to repeat, retrying only an unreachable
 * relay.
 *
 * Every write this ceremony makes is idempotent for an identical payload —
 * the relay answers a repeated offer, reveal or create with the state it
 * already holds — so a lost response is worth sending again rather than
 * ending an exchange the relay is still perfectly willing to finish. Anything
 * the relay actually pronounced propagates, as everywhere else here.
 */
async function persist<T>(
  write: () => Promise<T>,
  pause: () => Promise<void>,
  check: () => void = () => {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    check();
    try {
      return await write();
    } catch (error) {
      if (!(error instanceof KeyTransferUnavailableError)) throw error;
      if (attempt >= MAX_READ_FAILURES) throw new KeyTransferUnreachableError();
      await pause();
    }
  }
}

/**
 * Ask this account's other machines for its document key.
 *
 * Returns as soon as the request is minted; the exchange runs detached and is
 * observed through {@link KeyTransferRequestSession.view}, the same way a login
 * attempt is. `onKey` fires once, synchronously, at the moment a delivered key
 * has been proven — callers commit credentials there, and only a commit they
 * report as successful lets this machine claim the envelope off the relay.
 */
export async function startKeyTransferRequest(options: {
  relay: KeyTransferRelay;
  machineName: string;
  accountId: string;
  serviceOrigin: string;
  /** The account's wrapped task keys. A delivered key that opens none of them
   * is refused: the relay does not get to choose what this machine encrypts
   * its documents with. */
  wrappedKeys: SyncWrappedKey[];
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  /** Commit the proven key. Returns whether it was actually persisted: the
   * envelope is not claimed if persistence fails. */
  onKey?: (masterKey: string) => boolean | void;
}): Promise<KeyTransferRequestSession> {
  const pause = pauser(options.sleep ?? defaultSleep);
  const now = options.now ?? (() => new Date());
  const recipient = createKeyTransferRecipient();

  // Minting the request is what this call is: it either produces a request the
  // user can be told to go and approve, or it fails here where the caller can
  // say so, rather than becoming a session in a state nobody can act on.
  //
  // The id and the whole payload are chosen once, here, and repeated verbatim
  // by every retry: a lost create response is then a request this machine can
  // go and read rather than a second row burning one of the account's few
  // live slots. See `docs/key-transfer-protocol.md`.
  const requestId = randomUUID();
  const draft = {
    commitment: recipient.commitment,
    machineName: options.machineName,
    now: now(),
    requestId,
  };
  const deadline = draft.now.getTime() + KEY_TRANSFER_MAX_LIFETIME_MS;
  const created = await mint();
  // The deadline is this machine's, fixed now, and never read back from the
  // relay: the whole point is that the relay cannot extend it.

  async function mint(): Promise<KeyTransferRecord> {
    for (let attempt = 0; ; attempt += 1) {
      if (now().getTime() >= deadline) throw new KeyTransferExpiredError();
      try {
        return await options.relay.create(draft);
      } catch (error) {
        // A conflict on an id this machine chose is its own earlier create,
        // answered after the answer went missing. Read it rather than mint a
        // new one.
        const recoverable =
          error instanceof KeyTransferConflictError ||
          error instanceof KeyTransferUnavailableError;
        if (!recoverable) throw error;
        const existing = await options.relay.read(requestId).catch((readError: unknown) => {
          if (!(readError instanceof KeyTransferUnavailableError)) throw readError;
          return null;
        });
        if (existing) return existing;
        if (!(error instanceof KeyTransferUnavailableError)) throw error;
        if (attempt >= MAX_READ_FAILURES) throw new KeyTransferUnreachableError();
        await pause();
      }
    }
  }

  let view: KeyTransferRequestView = {
    requestId,
    locator: created.locator,
    machineName: options.machineName,
    state: "waiting-for-approval",
  };
  let masterKey: string | undefined;
  let cancelled = false;

  function checkLive(): void {
    if (cancelled) throw new Error(KEY_TRANSFER_GONE_MESSAGE);
    if (now().getTime() >= deadline) throw new KeyTransferExpiredError();
  }

  const session: KeyTransferRequestSession = {
    get view() {
      return view;
    },
    key: () => masterKey,
    async cancel() {
      cancelled = true;
      if (!SETTLED.includes(view.state)) view = { ...view, state: "cancelled" };
      await options.relay.cancel(requestId).catch(() => undefined);
    },
  };

  void run(created, deadline).catch(fail);

  async function run(created: KeyTransferRecord, deadline: number): Promise<void> {
    let exchange: KeyTransferExchange | undefined;
    let record: KeyTransferRecord | null = created;
    let readFailures = 0;

    for (;;) {
      if (cancelled) return;
      if (now().getTime() >= deadline) {
        view = { ...view, state: "expired", error: KEY_TRANSFER_EXPIRED_MESSAGE };
        return;
      }
      if (!record) {
        view = { ...view, state: "failed", error: KEY_TRANSFER_GONE_MESSAGE };
        return;
      }
      if (settledByRelay(record.state)) return;

      // Read is not belief: every poll re-checks the relayed context against
      // what this machine knows locally before acting on any of it.
      assertKeyTransferContext(record.context, {
        accountId: options.accountId,
        serviceOrigin: options.serviceOrigin,
        now: now(),
      });

      if (!exchange && record.senderPublicKey) {
        // `acceptOffer` is what fixes this machine's transcript: a later poll
        // carrying a different offer or context is refused by the arithmetic,
        // not by this loop.
        exchange = recipient.acceptOffer(record.senderPublicKey, record.context);
        const revealed = exchange;
        await persist(
          () => options.relay.reveal(record!.context.requestId, revealed.publicKey),
          pause,
          checkLive,
        );
        checkLive();
        view = {
          ...view,
          state: "comparing",
          verificationCode: exchange.verificationCode,
        };
      }

      if (exchange && record.envelope) {
        // Claimed only after the key is proven *and* the caller says it wrote
        // it down: claiming is what tells the relay to drop the ciphertext,
        // and this is the only copy anyone has of it.
        if (!deliver(exchange, record.envelope)) return;
        await options.relay.claim(record.context.requestId).catch(() => undefined);
        return;
      }

      await pause();
      try {
        record = await options.relay.read(created.context.requestId);
        readFailures = 0;
      } catch (error) {
        // Only an unreachable relay is worth waiting through. Anything it
        // actually pronounced is about this request, and the last record this
        // machine read is still the best thing it knows.
        if (!(error instanceof KeyTransferUnavailableError)) throw error;
        readFailures += 1;
        if (readFailures >= MAX_READ_FAILURES) throw new KeyTransferUnreachableError();
      }
    }
  }

  /** Open, prove, hand over — with no `await` between the proof and the
   * handover, so a cancellation cannot interleave with a commit. Answers
   * whether the key is now this machine's to keep. */
  function deliver(
    exchange: KeyTransferExchange,
    envelope: NonNullable<KeyTransferRecord["envelope"]>,
  ): boolean {
    const opened = exchange.open(envelope);
    const proven =
      options.wrappedKeys.length > 0
        ? validateDocumentKey(opened, options.wrappedKeys)
        : opened;
    if (cancelled) return false;
    masterKey = proven;
    let stored: boolean;
    try {
      stored = options.onKey === undefined ? true : options.onKey(proven) !== false;
    } catch {
      stored = false;
    }
    if (!stored) {
      // The envelope stays where it is. Nothing here is worth losing the one
      // approval the user already made in front of another machine.
      masterKey = undefined;
      view = {
        ...view,
        state: "failed",
        error: KEY_TRANSFER_NOT_STORED_MESSAGE,
        verificationCode: undefined,
      };
      return false;
    }
    view = { ...view, state: "complete", verificationCode: undefined };
    return true;
  }

  /** Map a relay-side ending onto this machine's view. */
  function settledByRelay(state: KeyTransferRecord["state"]): boolean {
    if (state === "denied") {
      view = { ...view, state: "denied", error: KEY_TRANSFER_DENIED_MESSAGE };
      return true;
    }
    if (state === "cancelled" || state === "claimed") {
      view = { ...view, state: "cancelled", error: KEY_TRANSFER_GONE_MESSAGE };
      return true;
    }
    if (state === "expired") {
      view = { ...view, state: "expired", error: KEY_TRANSFER_EXPIRED_MESSAGE };
      return true;
    }
    return false;
  }

  function fail(error: unknown): void {
    if (cancelled || SETTLED.includes(view.state)) return;
    if (error instanceof KeyTransferExpiredError) {
      view = { ...view, state: "expired", error: error.message };
      return;
    }
    view = {
      ...view,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return session;
}

const SETTLED: readonly KeyTransferRequestState[] = [
  "complete",
  "denied",
  "cancelled",
  "expired",
  "failed",
];

export interface KeyTransferApproverSession {
  list(): Promise<PendingKeyTransfer[]>;
  /** Offer this machine's key, and — once the other machine reveals its own —
   * produce the code the user must compare. Repeating the call re-uses the
   * same offer: a second offer would be a second exchange, and one the user
   * never compared a code for. */
  inspect(requestId: string): Promise<KeyTransferInspection>;
  /** Seal this account's key for a request whose code the user has confirmed.
   * Refuses a request that has not been inspected: approving one sight unseen
   * would approve a comparison nobody made. */
  approve(requestId: string): Promise<void>;
  deny(requestId: string): Promise<void>;
}

/** The relay-side states a request can still be acted on from. */
const OPEN_STATES: readonly KeyTransferRecord["state"][] = [
  "pending",
  "offered",
  "revealed",
  "approved",
];

export const KEY_TRANSFER_UNCOMPARED_MESSAGE =
  "This request has not been compared on this machine yet. Open it and check the codes match before approving.";

/**
 * The already-signed-in machine's end: find this account's waiting requests,
 * join one exchange each, and seal the master key for the one the user
 * confirms.
 */
export function createKeyTransferApproverSession(options: {
  relay: KeyTransferRelay;
  accountId: string;
  serviceOrigin: string;
  /** This machine's copy of the account's document key — the thing being
   * transferred, held here and never given to the relay unsealed. */
  masterKey: string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}): KeyTransferApproverSession {
  const pause = pauser(options.sleep ?? defaultSleep);
  const now = options.now ?? (() => new Date());
  /** One exchange per request, for the life of this process. */
  const joined = new Map<
    string,
    {
      approver: ReturnType<typeof createKeyTransferApprover>;
      deadline: number;
      approval?: { verificationCode: string; seal: (key: string) => unknown };
    }
  >();

  /** A request this machine is willing to look at: relayed context checked
   * against local account, origin, protocol version and clock. */
  function accept(record: KeyTransferRecord): KeyTransferRequestContext | null {
    try {
      assertKeyTransferContext(record.context, {
        accountId: options.accountId,
        serviceOrigin: options.serviceOrigin,
        now: now(),
      });
      return record.context;
    } catch {
      return null;
    }
  }

  return {
    async list() {
      const pending = await options.relay.listPending();
      return pending
        .filter((record) => accept(record) !== null)
        .map((record) => ({
          requestId: record.context.requestId,
          locator: record.locator,
          machineName: record.context.machineName,
          expiresAt: record.context.expiresAt,
        }));
    },

    async inspect(requestId) {
      // Bounded: `inspect` answers a board request, and a request that waits
      // for the other machine to reveal is a request that never returns. The
      // board asks again, which is also how it notices a request going away.
      let waiting: KeyTransferRecord | undefined;
      for (let poll = 0; poll < INSPECT_POLLS; poll += 1) {
        let record: KeyTransferRecord | null;
        try {
          record = await options.relay.read(requestId);
        } catch (error) {
          // The same rule as the requesting machine's: a dropped response is
          // not news about the request, so it costs a poll rather than the
          // exchange this machine has already joined.
          if (!(error instanceof KeyTransferUnavailableError)) throw error;
          await pause();
          continue;
        }
        const context = record && accept(record);
        if (!record || !context) return gone(requestId);
        // A request that has finished being one — claimed, cancelled, denied,
        // expired — is over regardless of how far its exchange got. Asked
        // after the fact it still carries both machines' keys, and answering
        // "comparing" would put a code back on screen for a request the other
        // machine has already walked away from.
        if (!OPEN_STATES.includes(record.state)) return gone(requestId);
        waiting = record;

        let entry = joined.get(requestId);
        if (!entry) {
          entry = {
            approver: createKeyTransferApprover(context),
            deadline: now().getTime() + KEY_TRANSFER_MAX_LIFETIME_MS,
          };
          joined.set(requestId, entry);
        }
        if (now().getTime() >= entry.deadline) return gone(requestId);

        if (record.state === "pending") {
          const offer = entry.approver.publicKey;
          await persist(() => options.relay.offer(requestId, offer), pause, () => {
            if (now().getTime() >= entry.deadline) throw new KeyTransferExpiredError();
            assertKeyTransferContext(context, { accountId: options.accountId, serviceOrigin: options.serviceOrigin, now: now() });
          });
        } else if (
          record.senderPublicKey &&
          record.senderPublicKey !== entry.approver.publicKey
        ) {
          // Someone else's offer already owns this exchange. This machine
          // cannot join it, and must not pretend to.
          return gone(requestId);
        }

        if (record.recipientPublicKey) {
          entry.approval ??= entry.approver.acceptReveal(
            record.recipientPublicKey,
            context,
          );
          return {
            requestId,
            locator: record.locator,
            machineName: context.machineName,
            state: "comparing",
            verificationCode: entry.approval.verificationCode,
          };
        }
        await pause();
      }
      // Nothing was read at all: every poll's response went missing, which is
      // an outage the board has to be told about rather than a nameless
      // request it can go on spinning over.
      if (!waiting) throw new KeyTransferUnreachableError();
      return {
        requestId,
        locator: waiting.locator,
        machineName: waiting.context.machineName,
        state: "waiting-for-reveal",
      };
    },

    async approve(requestId) {
      const entry = joined.get(requestId);
      if (!entry?.approval) throw new Error(KEY_TRANSFER_UNCOMPARED_MESSAGE);
      if (now().getTime() >= entry.deadline) throw new KeyTransferExpiredError();
      const envelope = entry.approval.seal(options.masterKey) as {
        senderPublicKey: string;
        ciphertext: string;
      };
      try {
        await persist(() => options.relay.approve(requestId, envelope), pause, () => {
          if (now().getTime() >= entry.deadline) throw new KeyTransferExpiredError();
        });
      } catch (error) {
        // An already-approved request answers the same way for a retried
        // response as for the first: the relay keeps the envelope it has.
        if (!(error instanceof KeyTransferConflictError)) throw error;
        if (error.state !== "approved") throw error;
      }
    },

    async deny(requestId) {
      joined.delete(requestId);
      await options.relay.deny(requestId);
    },
  };

  function gone(requestId: string): KeyTransferInspection {
    joined.delete(requestId);
    return {
      requestId,
      locator: "",
      machineName: "",
      state: "gone",
    };
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
