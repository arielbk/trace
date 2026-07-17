import { describe, expect, test } from "vitest";
import { createDocCrypto, generateDocCryptoKey } from "./doc-crypto.ts";

const encode = (value: string) => new TextEncoder().encode(value);

describe("document crypto", () => {
  test("seals and opens a blob using its deterministic address", () => {
    const crypto = createDocCrypto("11".repeat(32));
    const plaintext = encode("private task notes");

    const opened = crypto.openBlob(crypto.sealBlob(plaintext), crypto.address(plaintext));

    expect(opened).toEqual(plaintext);
  });

  test("derives stable addresses across machines while using fresh encryption nonces", () => {
    const first = createDocCrypto("22".repeat(32));
    const second = createDocCrypto("22".repeat(32));
    const plaintext = encode("same document");

    expect(first.address(plaintext)).toBe(second.address(plaintext));
    expect(first.sealBlob(plaintext)).not.toEqual(second.sealBlob(plaintext));
  });

  test("seals and opens manifest file metadata with a purpose-specific key", () => {
    const crypto = createDocCrypto("33".repeat(32));
    const files = [
      {
        path: "state.md",
        blobHash: "ab".repeat(32),
        title: "Current state",
        description: "Private metadata",
      },
    ];

    expect(crypto.openFilesList(crypto.sealFilesList(files))).toEqual(files);

    const blobEnvelope = crypto.sealBlob(encode(JSON.stringify(files)));
    expect(() =>
      crypto.openFilesList(Buffer.from(blobEnvelope).toString("base64")),
    ).toThrow();
  });

  test("rejects tampered, truncated, and unknown-version envelopes", () => {
    const crypto = createDocCrypto("44".repeat(32));
    const plaintext = encode("untampered");
    const address = crypto.address(plaintext);
    const sealed = crypto.sealBlob(plaintext);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] =
      (tampered[tampered.length - 1] ?? 0) ^ 1;
    const unknownVersion = sealed.slice();
    unknownVersion[0] = 2;

    expect(() => crypto.openBlob(tampered, address)).toThrow();
    expect(() => crypto.openBlob(sealed.subarray(0, 8), address)).toThrow(
      "truncated",
    );
    expect(() => crypto.openBlob(unknownVersion, address)).toThrow(
      "unsupported version",
    );
  });

  test("rejects the wrong key and a mismatched claimed address", () => {
    const first = createDocCrypto("55".repeat(32));
    const second = createDocCrypto("66".repeat(32));
    const plaintext = encode("bound to its owner and address");
    const sealed = first.sealBlob(plaintext);

    expect(() => second.openBlob(sealed, first.address(plaintext))).toThrow();
    expect(() => first.openBlob(sealed, first.address(encode("other")))).toThrow(
      "address verification failed",
    );
  });

  test("accepts only 32-byte hexadecimal master keys and generates valid keys", () => {
    expect(() => createDocCrypto("too short")).toThrow(
      "64 hexadecimal characters",
    );
    expect(generateDocCryptoKey()).toMatch(/^[0-9a-f]{64}$/);
  });
});
