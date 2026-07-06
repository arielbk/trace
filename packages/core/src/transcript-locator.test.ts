import { describe, expect, test } from "vitest";
import {
  composerIdFromLocator,
  cursorLocatorFlavor,
  isSyntheticLocator,
  syntheticLocator,
} from "./transcript-locator.ts";

describe("syntheticLocator", () => {
  test("mints and recognizes the <tool>:<id> form", () => {
    expect(syntheticLocator("cursor", "composer-1")).toBe("cursor:composer-1");
    expect(isSyntheticLocator("codex:thread-1", "codex")).toBe(true);
    expect(isSyntheticLocator("/tmp/thread-1.jsonl", "codex")).toBe(false);
  });

  test("prefixes are per-tool", () => {
    expect(isSyntheticLocator("cursor:composer-1", "codex")).toBe(false);
  });
});

describe("cursorLocatorFlavor", () => {
  test("a synthetic locator is a composer", () => {
    expect(cursorLocatorFlavor("cursor:composer-1")).toBe("composer");
  });

  test("a bare composerId is a composer", () => {
    expect(cursorLocatorFlavor("composer-1")).toBe("composer");
  });

  test("an absolute .jsonl path is an agent transcript", () => {
    expect(
      cursorLocatorFlavor(
        "/home/u/.cursor/projects/repo/agent-transcripts/chat-1/chat-1.jsonl",
      ),
    ).toBe("agent-transcript");
  });
});

describe("composerIdFromLocator", () => {
  test("unpacks the synthetic form and passes a bare id through", () => {
    expect(composerIdFromLocator("cursor:composer-1")).toBe("composer-1");
    expect(composerIdFromLocator("composer-1")).toBe("composer-1");
  });
});
