import { expect, test } from "vitest";
import {
  generatePlaceholderSlug,
  humanizeSlug,
  looksLikeSlug,
  slugify,
} from "./slug.ts";

test("lowercases and hyphenates words", () => {
  expect(slugify("Manual Break Start")).toBe("manual-break-start");
});

test("strips punctuation and collapses separators", () => {
  expect(slugify("Fix: the bug (again)!!")).toBe("fix-the-bug-again");
});

test("collapses runs of whitespace and underscores into a single dash", () => {
  expect(slugify("a  b\t\tc__d")).toBe("a-b-c-d");
});

test("trims leading and trailing separators", () => {
  expect(slugify("  --Hello, World--  ")).toBe("hello-world");
});

test("transliterates accented latin characters", () => {
  expect(slugify("Café Crème brûlée")).toBe("cafe-creme-brulee");
});

test("drops non-latin script that cannot be transliterated", () => {
  expect(slugify("日本語 task")).toBe("task");
});

test("keeps digits", () => {
  expect(slugify("Release v2 build 17")).toBe("release-v2-build-17");
});

test("caps the slug length at the word boundary", () => {
  const long = "word ".repeat(40).trim();
  const slug = slugify(long);
  expect(slug.length).toBeLessThanOrEqual(60);
  expect(slug.endsWith("-")).toBe(false);
  expect(slug.startsWith("word")).toBe(true);
});

test("returns empty string when nothing slug-worthy remains", () => {
  expect(slugify("!!! ??? ---")).toBe("");
  expect(slugify("   ")).toBe("");
});

test("looksLikeSlug accepts kebab-case with at least one dash", () => {
  expect(looksLikeSlug("break-stop-and-stale-expiry")).toBe(true);
  expect(looksLikeSlug("release-v2-build-17")).toBe(true);
});

test("looksLikeSlug rejects single words, mixed case, and UUIDs", () => {
  expect(looksLikeSlug("checkout")).toBe(false);
  expect(looksLikeSlug("Fix-the-Bug")).toBe(false);
  expect(looksLikeSlug("fix the bug")).toBe(false);
  expect(looksLikeSlug("271d0e57-0f84-4eaa-91f9-2b55570a898b")).toBe(false);
});

test("humanizeSlug spaces the dashes and capitalizes the first letter", () => {
  expect(humanizeSlug("break-stop-and-stale-expiry")).toBe(
    "Break stop and stale expiry",
  );
});

test("placeholder slug derives a short stable handle from an id", () => {
  const slug = generatePlaceholderSlug("271d0e57-0f84-4eaa-91f9-2b55570a898b");
  expect(slug).toBe("task-271d0e57");
});

test("placeholder slug falls back to the whole id when there is no dash", () => {
  expect(generatePlaceholderSlug("abc123")).toBe("task-abc123");
});
