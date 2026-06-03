import { describe, expect, test } from "vitest";
import { nextTheme, resolveInitialTheme, THEME_STORAGE_KEY } from "./theme.ts";

describe("resolveInitialTheme", () => {
  test("a stored 'dark' override wins over OS preference", () => {
    expect(resolveInitialTheme("dark", false)).toBe("dark");
  });

  test("a stored 'light' override wins over OS preference", () => {
    expect(resolveInitialTheme("light", true)).toBe("light");
  });

  test("falls back to OS dark preference when nothing is stored", () => {
    expect(resolveInitialTheme(null, true)).toBe("dark");
  });

  test("falls back to OS light preference when nothing is stored", () => {
    expect(resolveInitialTheme(null, false)).toBe("light");
  });

  test("ignores a malformed stored value and uses OS preference", () => {
    expect(resolveInitialTheme("purple", true)).toBe("dark");
    expect(resolveInitialTheme("", false)).toBe("light");
  });
});

describe("nextTheme", () => {
  test("flips dark to light", () => {
    expect(nextTheme("dark")).toBe("light");
  });

  test("flips light to dark", () => {
    expect(nextTheme("light")).toBe("dark");
  });
});

test("THEME_STORAGE_KEY is a stable namespaced key", () => {
  expect(THEME_STORAGE_KEY).toBe("trace.theme");
});
