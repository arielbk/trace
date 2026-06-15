import { expect, test } from "vitest";
import { cn } from "./utils.ts";

test("cn merges class strings", () => {
  expect(cn("foo", "bar")).toBe("foo bar");
});

test("cn deduplicates conflicting Tailwind classes", () => {
  expect(cn("p-4", "p-6")).toBe("p-6");
});

test("cn drops falsy values", () => {
  const falsy: boolean = false;
  expect(cn("foo", falsy && "bar", undefined, "baz")).toBe("foo baz");
});
