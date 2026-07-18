import { describe, expect, test } from "vitest";
import {
  createKeyWrapper,
  createTaskDocCrypto,
  generateTaskKey,
} from "./doc-crypto.ts";

const encode = (value: string) => new TextEncoder().encode(value);

describe("task document crypto", () => {
  test("seals and opens a blob using its deterministic address", () => {
    const crypto = createTaskDocCrypto("11".repeat(32));
    const plaintext = encode("private task notes");

    const opened = crypto.openBlob(crypto.sealBlob(plaintext), crypto.address(plaintext));

    expect(opened).toEqual(plaintext);
  });

  test("derives stable addresses across machines while using fresh encryption nonces", () => {
    const first = createTaskDocCrypto("22".repeat(32));
    const second = createTaskDocCrypto("22".repeat(32));
    const plaintext = encode("same document");

    expect(first.address(plaintext)).toBe(second.address(plaintext));
    expect(first.sealBlob(plaintext)).not.toEqual(second.sealBlob(plaintext));
  });

  test("seals and opens manifest file metadata with a purpose-specific key", () => {
    const crypto = createTaskDocCrypto("33".repeat(32));
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
    const crypto = createTaskDocCrypto("44".repeat(32));
    const plaintext = encode("untampered");
    const address = crypto.address(plaintext);
    const sealed = crypto.sealBlob(plaintext);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] =
      (tampered[tampered.length - 1] ?? 0) ^ 1;
    const unknownVersion = sealed.slice();
    unknownVersion[0] = 9;

    expect(() => crypto.openBlob(tampered, address)).toThrow();
    expect(() => crypto.openBlob(sealed.subarray(0, 8), address)).toThrow(
      "truncated",
    );
    expect(() => crypto.openBlob(unknownVersion, address)).toThrow(
      "unsupported version",
    );
  });

  test("rejects the wrong key and a mismatched claimed address", () => {
    const first = createTaskDocCrypto("55".repeat(32));
    const second = createTaskDocCrypto("66".repeat(32));
    const plaintext = encode("bound to its owner and address");
    const sealed = first.sealBlob(plaintext);

    expect(() => second.openBlob(sealed, first.address(plaintext))).toThrow();
    expect(() => first.openBlob(sealed, first.address(encode("other")))).toThrow(
      "address verification failed",
    );
  });

  test("isolates one task key from another across every surface", () => {
    const taskA = createTaskDocCrypto("aa".repeat(32));
    const taskB = createTaskDocCrypto("bb".repeat(32));
    const plaintext = encode("task A only");
    const files = [{ path: "state.md", blobHash: "cd".repeat(32) }];

    // Addresses do not collide across tasks (subkeys are task-scoped).
    expect(taskA.address(plaintext)).not.toBe(taskB.address(plaintext));
    // A blob sealed under A never opens under B.
    expect(() =>
      taskB.openBlob(taskA.sealBlob(plaintext), taskA.address(plaintext)),
    ).toThrow();
    // A manifest sealed under A never opens under B.
    expect(() => taskB.openFilesList(taskA.sealFilesList(files))).toThrow();
  });

  test("rejects a v1 envelope loudly instead of decrypting it", () => {
    const crypto = createTaskDocCrypto("77".repeat(32));
    const sealed = crypto.sealBlob(encode("v2 payload"));
    const legacyV1 = sealed.slice();
    legacyV1[0] = 1;

    expect(() => crypto.openBlob(legacyV1, crypto.address(encode("v2 payload")))).toThrow(
      "unsupported version",
    );
  });

  test("accepts only 32-byte hexadecimal task keys and generates valid keys", () => {
    expect(() => createTaskDocCrypto("too short")).toThrow(
      "64 hexadecimal characters",
    );
    expect(generateTaskKey()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("task key wrapper", () => {
  test("wraps and unwraps a task key with the master KEK", () => {
    const wrapper = createKeyWrapper("12".repeat(32));
    const taskKey = generateTaskKey();

    const wrapped = wrapper.wrapTaskKey(taskKey);

    expect(wrapped).not.toContain(taskKey);
    expect(wrapper.unwrapTaskKey(wrapped)).toBe(taskKey);
  });

  test("uses fresh nonces so re-wrapping the same key differs", () => {
    const wrapper = createKeyWrapper("34".repeat(32));
    const taskKey = generateTaskKey();

    expect(wrapper.wrapTaskKey(taskKey)).not.toBe(wrapper.wrapTaskKey(taskKey));
  });

  test("fails to unwrap under the wrong master key", () => {
    const owner = createKeyWrapper("56".repeat(32));
    const attacker = createKeyWrapper("78".repeat(32));
    const wrapped = owner.wrapTaskKey(generateTaskKey());

    expect(() => attacker.unwrapTaskKey(wrapped)).toThrow();
  });

  test("rejects malformed task keys and non-32-byte master keys", () => {
    expect(() => createKeyWrapper("nope")).toThrow("64 hexadecimal characters");
    const wrapper = createKeyWrapper("9a".repeat(32));
    expect(() => wrapper.wrapTaskKey("short")).toThrow(
      "64 hexadecimal characters",
    );
  });
});
