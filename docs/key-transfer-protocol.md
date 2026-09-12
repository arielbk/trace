# Document-key transfer protocol v1

This decision records how a second local service obtains an existing account's
master document key. Recovery-key entry remains the fallback. Private keys,
cloud bearer tokens and the decrypted master key stay in the local services;
the hosted board displays request state and comparison codes only.

## Threat model and construction

The relay may read, substitute, reorder, replay, delay or discard messages. It
may impersonate either account-side participant at the transport layer. It must
not learn the master key unless the user approves mismatching codes. A
compromised local service or hosted UI is outside this cryptographic guarantee:
the comparison requires trustworthy local displays and the user checking both.
Availability against the relay is not promised.

The construction uses X25519, HKDF-SHA256 and AES-256-GCM. Recipient-key
authentication uses a commit/offer/reveal exchange followed by a human comparison
of a 40-bit code derived from the shared secret and the complete transcript.
The commit-before-reveal ordering follows the principle in
[RFC 6189 sections 4.4.1.1 and 7](https://datatracker.ietf.org/doc/html/rfc6189).
This is a purpose-specific protocol, not an implementation of ZRTP. Its security
argument depends on the ordering and immutable state described below, in
addition to the security of these primitives.

The earlier draft derived a short code from public request fields and published
the recipient key immediately. That allowed offline substitution searches and
has been rejected. A short locator or a public transcript hash is insufficient.

## Exchange and local state

1. B creates an ephemeral X25519 key pair and publishes only a domain-separated
   SHA-256 commitment to its public key. The private key and unrevealed public
   key remain in B's process.
2. The request records protocol version, request ID, account ID, configured
   service origin, descriptive machine name, expiry and commitment. Both
   services validate the account and origin against their local authenticated
   state. B pins its request ID, expiry, name and commitment from creation;
   subsequent relay reads cannot replace that context.
3. A pins a copy of this complete context **before** generating/publishing its
   offered ephemeral public key. The crypto API requires the context at
   approver construction and rejects changed context at reveal.
4. B accepts exactly one offered public key for its request, derives the shared
   secret and reveals its committed public key. A retry of the identical offer
   returns the same exchange; another key or context is refused. This is a local
   invariant even when the relay ignores its own state machine.
5. A verifies that B's reveal opens the pinned commitment. Both sides derive
   the comparison code from the shared secret and complete transcript. The UI
   must require explicit confirmation of the code shown on B before A seals
   the master key. Machine names and request locators carry no authority.
6. A seals the key for this exchange. B checks the envelope's sender key,
   authenticates/decrypts it, and verifies the received master key against the
   account's existing wrapped task keys before committing credentials.
7. B explicitly acknowledges delivery only after local verification and commit.
   Reading an envelope is non-consuming, so a lost read response is retryable.
   The local service must cache the first outgoing offer/reveal/approval for
   retries and never create a fresh exchange inside an existing request.

A relay substituting keys must fix its recipient commitment before learning A's
offer, and fix its offer to B before learning B's revealed key. The complete
context is fixed before those steps, leaving no later public field to vary in a
code search. Under the cryptographic assumptions, a false match has probability
approximately 2^-40 per independent exchange. The user must reject mismatches;
there is no claim that automatic tests constitute a cryptographic proof.

## Transcript and encoding

The transcript is a sequence of UTF-8 fields, each prefixed with its four-byte
big-endian byte length:

- `trace-key-transfer:v1`, protocol version, request ID;
- stable account ID and locally configured service origin;
- descriptive machine name and fixed ISO expiry;
- recipient commitment, sender public key, recipient public key.

Public keys use Base64 SPKI DER and must identify X25519. The commitment is
SHA-256 of `trace-key-transfer:commitment:v1\n` followed by the encoded recipient
key. Context fields are nonempty, bounded and free of control characters.

HKDF uses the X25519 shared secret and SHA-256(transcript) as salt. Distinct info
labels derive the 32-byte envelope key and five-byte comparison value. The code
uses Crockford Base32 in two four-character groups. The six-character request
locator uses a separate label and request ID only; it is explicitly not secret.

AES-GCM uses a fresh 12-byte nonce and a 16-byte tag. The complete transcript is
additional authenticated data. The plaintext must be exactly 32 bytes. An
envelope naming a different sender key is refused before decryption.

## Relay contract and lifecycle

The relay must implement `pending → offered → revealed → approved → claimed`,
with denial, cancellation and expiry from any unfinished state. Offer/reveal
must be immutable once accepted; identical transport retries return the same
state, and different values conflict. Approval attaches only an opaque envelope.
Claim erases that envelope and is retry-safe after a lost acknowledgement.
Every route is account-scoped. Unknown protocol versions fail closed.

The request lifetime is at most ten minutes. Each local service checks its own
clock and fixed deadline, independently of relay claims. A relay response cannot
extend an attempt. Request creation and polling are bounded; creation limits
must be atomic at the database boundary. Expired records are removed by cleanup.

Both local services keep ephemeral private keys only in process memory. Restart
abandons a live exchange and gives an explicit restart/recovery-key action.
Cancellation or superseding an attempt must invalidate every in-flight response
before it can persist credentials or trigger sync. Polling stops at a terminal
state or local deadline. Approval/claim retries must not discard the only
recoverable envelope before successful receipt.

This transfers one key, not durable device membership. Revoking browser pairing
cannot retract a key already transferred. Separate-account migration, teams,
key rotation and browser-only decryption are outside this protocol.

## Implementation gate

The crypto primitives and attacker-model regressions enforce fixed context at
offer and single-offer recipient disclosure. The relay schema/handlers, local
attempt lifecycle and hosted ceremony must enforce the rest before a transfer
capability is advertised. Verification must compose two independent local
runtimes with the real relay handlers and database, including cross-account,
substitution, altered ciphertext, wrong-code, cancellation, expiry, restart,
response-loss and concurrent-transition cases.
