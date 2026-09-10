import { randomUUID } from "node:crypto";
import {
  KEY_TRANSFER_MAX_LIFETIME_MS,
  KEY_TRANSFER_PROTOCOL_VERSION,
  keyTransferLocator,
  type KeyTransferEnvelope,
  type KeyTransferRequestContext,
} from "@trace/core";
import { errorMessage, readJson, type AuthFetch } from "./auth-service.ts";

/**
 * This machine's end of the key-transfer relay (`/api/key-transfer/...`).
 *
 * The relay is assumed hostile — see `docs/key-transfer-protocol.md` — so this
 * module's job is narrow and suspicious: send well-formed requests, and turn
 * whatever comes back into a {@link KeyTransferRecord} whose shape has been
 * checked. It deliberately does *not* decide whether a record is trustworthy:
 * that is `assertKeyTransferContext`'s job, against what the caller knows
 * locally. Believing a relayed `accountId` because it parsed is exactly the
 * mistake the protocol is built to survive.
 */

export type KeyTransferState =
  | "pending"
  | "offered"
  | "revealed"
  | "approved"
  | "claimed"
  | "cancelled"
  | "denied"
  | "expired";

/** One request as the relay currently describes it. */
export interface KeyTransferRecord {
  /** The relayed request fields, unverified. */
  context: KeyTransferRequestContext;
  state: KeyTransferState;
  /** The short handle the user matches against the machine in front of them.
   * Derived here from the request id rather than read from the relay, so a
   * relay cannot label two rows alike. */
  locator: string;
  senderPublicKey?: string;
  recipientPublicKey?: string;
  envelope?: KeyTransferEnvelope;
}

/** A relay that answered, but not the way the request could continue from. */
export class KeyTransferConflictError extends Error {
  readonly state: KeyTransferState;
  constructor(state: KeyTransferState) {
    super(`This transfer request is already ${state}. Start a new one.`);
    this.state = state;
  }
}

export const KEY_TRANSFER_EXPIRED_MESSAGE =
  "That transfer request expired before it finished. Start a new one.";

export class KeyTransferExpiredError extends Error {
  constructor() {
    super(KEY_TRANSFER_EXPIRED_MESSAGE);
  }
}

const MALFORMED = "The sync server returned an unusable key-transfer response.";

export interface KeyTransferRelay {
  /** Publish a commitment and ask this account's other machines to approve.
   * The request id is minted here: a lost response is then recoverable by
   * reading the id this machine already chose, rather than by creating a
   * second request. */
  create(draft: {
    commitment: string;
    machineName: string;
    now: Date;
    lifetimeMs?: number;
    requestId?: string;
  }): Promise<KeyTransferRecord>;
  read(requestId: string): Promise<KeyTransferRecord | null>;
  /** The account's requests still waiting for a machine to approve them. */
  listPending(): Promise<KeyTransferRecord[]>;
  offer(requestId: string, senderPublicKey: string): Promise<KeyTransferRecord>;
  reveal(
    requestId: string,
    recipientPublicKey: string,
  ): Promise<KeyTransferRecord>;
  approve(
    requestId: string,
    envelope: KeyTransferEnvelope,
  ): Promise<KeyTransferRecord>;
  /** Take delivery of the envelope. Non-consuming reads come first, so this is
   * only sent once the key is opened and committed locally. */
  claim(requestId: string): Promise<KeyTransferRecord>;
  cancel(requestId: string): Promise<KeyTransferRecord>;
  deny(requestId: string): Promise<KeyTransferRecord>;
}

export function createKeyTransferRelay(options: {
  serverUrl: string;
  fetch: AuthFetch;
  accessToken: string;
}): KeyTransferRelay {
  const base = `${options.serverUrl.replace(/\/$/, "")}/api/key-transfer`;
  const origin = new URL(options.serverUrl).origin;

  async function send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; payload: unknown }> {
    const response = await options.fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await readJson<Record<string, unknown>>(response);
    return { status: response.status, payload };
  }

  /** Every mutating action answers the same way: the updated record, or one of
   * the three refusals the lifecycle defines. */
  async function act(
    path: string,
    body: unknown,
  ): Promise<KeyTransferRecord> {
    const { status, payload } = await send("POST", path, body);
    if (status === 409) throw new KeyTransferConflictError(conflictState(payload));
    if (status === 410) throw new KeyTransferExpiredError();
    if (status < 200 || status >= 300) {
      throw new Error(errorMessage(payload as { error?: string }));
    }
    return toRecord(payload);
  }

  return {
    async create(draft) {
      const requestId = draft.requestId ?? randomUUID();
      const lifetime = Math.min(
        draft.lifetimeMs ?? KEY_TRANSFER_MAX_LIFETIME_MS,
        KEY_TRANSFER_MAX_LIFETIME_MS,
      );
      return act("", {
        requestId,
        commitment: draft.commitment,
        machineName: draft.machineName,
        protocolVersion: KEY_TRANSFER_PROTOCOL_VERSION,
        serviceOrigin: origin,
        expiresAt: new Date(draft.now.getTime() + lifetime).toISOString(),
      });
    },

    async read(requestId) {
      const { status, payload } = await send(
        "GET",
        `/${encodeURIComponent(requestId)}`,
      );
      if (status === 404) return null;
      if (status < 200 || status >= 300) {
        throw new Error(errorMessage(payload as { error?: string }));
      }
      return toRecord(payload);
    },

    async listPending() {
      const { status, payload } = await send("GET", "");
      if (status < 200 || status >= 300) {
        throw new Error(errorMessage(payload as { error?: string }));
      }
      if (!Array.isArray(payload)) throw new Error(MALFORMED);
      return payload.map(toRecord);
    },

    offer: (requestId, senderPublicKey) =>
      act(`/${encodeURIComponent(requestId)}/offer`, { senderPublicKey }),
    reveal: (requestId, recipientPublicKey) =>
      act(`/${encodeURIComponent(requestId)}/reveal`, { recipientPublicKey }),
    approve: (requestId, envelope) =>
      act(`/${encodeURIComponent(requestId)}/approve`, envelope),
    claim: (requestId) => act(`/${encodeURIComponent(requestId)}/claim`, {}),
    cancel: (requestId) => act(`/${encodeURIComponent(requestId)}/cancel`, {}),
    deny: (requestId) => act(`/${encodeURIComponent(requestId)}/deny`, {}),
  };
}

const STATES: readonly string[] = [
  "pending",
  "offered",
  "revealed",
  "approved",
  "claimed",
  "cancelled",
  "denied",
  "expired",
];

function conflictState(payload: unknown): KeyTransferState {
  const state = (payload as { state?: unknown } | null)?.state;
  return typeof state === "string" && STATES.includes(state)
    ? (state as KeyTransferState)
    : "pending";
}

/**
 * Turn a relay response into a record, refusing anything whose shape could not
 * have come from the protocol. A malformed response is a failure, never a
 * partially believed request: half a context is exactly what an attacker would
 * send to see which field a machine checks first.
 */
function toRecord(payload: unknown): KeyTransferRecord {
  if (typeof payload !== "object" || payload === null) throw new Error(MALFORMED);
  const row = payload as Record<string, unknown>;
  const context: KeyTransferRequestContext = {
    protocolVersion: number(row.protocolVersion),
    requestId: text(row.requestId),
    accountId: text(row.accountId),
    serviceOrigin: text(row.serviceOrigin),
    machineName: text(row.machineName),
    expiresAt: text(row.expiresAt),
    commitment: text(row.commitment),
  };
  if (typeof row.state !== "string" || !STATES.includes(row.state)) {
    throw new Error(MALFORMED);
  }
  return {
    context,
    state: row.state as KeyTransferState,
    locator: keyTransferLocator(context.requestId),
    ...(row.senderPublicKey === undefined
      ? {}
      : { senderPublicKey: text(row.senderPublicKey) }),
    ...(row.recipientPublicKey === undefined
      ? {}
      : { recipientPublicKey: text(row.recipientPublicKey) }),
    ...(row.envelope === undefined ? {} : { envelope: toEnvelope(row.envelope) }),
  };
}

function toEnvelope(value: unknown): KeyTransferEnvelope {
  if (typeof value !== "object" || value === null) throw new Error(MALFORMED);
  const envelope = value as Record<string, unknown>;
  return {
    senderPublicKey: text(envelope.senderPublicKey),
    ciphertext: text(envelope.ciphertext),
  };
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error(MALFORMED);
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(MALFORMED);
  }
  return value;
}
