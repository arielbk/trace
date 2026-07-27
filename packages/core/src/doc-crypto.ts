import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENVELOPE_VERSION = 2;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

// v2 labels are task-scoped: subkeys derive from a per-task DEK, not the
// whole-corpus master key. The master key now only wraps task keys (see
// createKeyWrapper). No v1 label or v1 read path survives.
const ADDRESS_INFO = "trace-e2ee:task-blob-address:v2";
const BLOB_INFO = "trace-e2ee:task-blob-content:v2";
const MANIFEST_INFO = "trace-e2ee:task-manifest:v2";
const WRAP_INFO = "trace-e2ee:task-key-wrap:v2";

export type DocCryptoFile = {
  path: string;
  blobHash: string;
  title?: string;
  description?: string;
  // Source-machine fs mtime (ISO string). Rides inside filesCiphertext, so it
  // stays E2EE-opaque to the server; absent on manifests from older clients.
  modifiedAt?: string;
};

export type DocCrypto = {
  address(plaintext: Uint8Array): string;
  sealBlob(plaintext: Uint8Array): Uint8Array;
  openBlob(envelope: Uint8Array, expectedAddress: string): Uint8Array;
  sealFilesList(files: DocCryptoFile[]): string;
  openFilesList(ciphertext: string): DocCryptoFile[];
};

export type KeyWrapper = {
  wrapTaskKey(taskKeyHex: string): string;
  unwrapTaskKey(wrappedKey: string): string;
};

export function generateTaskKey(): string {
  return randomBytes(32).toString("hex");
}

export function createTaskDocCrypto(taskKeyHex: string): DocCrypto {
  const taskKey = parseKey(taskKeyHex);
  const addressKey = deriveKey(taskKey, ADDRESS_INFO);
  const blobKey = deriveKey(taskKey, BLOB_INFO);
  const manifestKey = deriveKey(taskKey, MANIFEST_INFO);

  const address = (plaintext: Uint8Array) => hmac(addressKey, plaintext);

  return {
    address,
    sealBlob: (plaintext) => seal(blobKey, plaintext),
    openBlob: (envelope, expectedAddress) => {
      const plaintext = open(blobKey, envelope);
      if (!sameAddress(address(plaintext), expectedAddress)) {
        throw new Error("document blob address verification failed");
      }
      return plaintext;
    },
    sealFilesList: (files) =>
      Buffer.from(seal(manifestKey, Buffer.from(JSON.stringify(files)))).toString(
        "base64",
      ),
    openFilesList: (ciphertext) => {
      const plaintext = open(manifestKey, Buffer.from(ciphertext, "base64"));
      const parsed: unknown = JSON.parse(Buffer.from(plaintext).toString("utf8"));
      if (!Array.isArray(parsed)) throw new Error("encrypted document file list is invalid");
      return parsed as DocCryptoFile[];
    },
  };
}

export function createKeyWrapper(masterKeyHex: string): KeyWrapper {
  const wrapKey = deriveKey(parseKey(masterKeyHex), WRAP_INFO);

  return {
    wrapTaskKey: (taskKeyHex) =>
      Buffer.from(seal(wrapKey, parseKey(taskKeyHex))).toString("base64"),
    unwrapTaskKey: (wrappedKey) =>
      Buffer.from(open(wrapKey, Buffer.from(wrappedKey, "base64"))).toString("hex"),
  };
}

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error("document encryption key must be 64 hexadecimal characters");
  }
  return Buffer.from(keyHex, "hex");
}

function deriveKey(baseKey: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", baseKey, Buffer.alloc(0), info, 32));
}

function hmac(key: Buffer, plaintext: Uint8Array): string {
  return createHmac("sha256", key).update(plaintext).digest("hex");
}

function seal(key: Buffer, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([ENVELOPE_VERSION]),
      nonce,
      ciphertext,
      cipher.getAuthTag(),
    ]),
  );
}

function open(key: Buffer, envelope: Uint8Array): Uint8Array {
  const bytes = Buffer.from(envelope);
  if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error("encrypted document envelope is truncated");
  }
  if (bytes[0] !== ENVELOPE_VERSION) {
    throw new Error("encrypted document envelope has an unsupported version");
  }
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const ciphertext = bytes.subarray(1 + NONCE_BYTES, -TAG_BYTES);
  const tag = bytes.subarray(-TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

function sameAddress(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
