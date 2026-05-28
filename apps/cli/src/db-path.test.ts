import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveDbPath } from "./db-path.ts";

describe("resolveDbPath", () => {
  test("returns TRACE_DB when set", () => {
    expect(resolveDbPath({ TRACE_DB: "/custom/path/trace.sqlite" })).toBe(
      "/custom/path/trace.sqlite",
    );
  });

  test("falls back to ~/.trace/trace.sqlite when TRACE_DB is unset", () => {
    expect(resolveDbPath({ HOME: "/home/user" })).toBe(
      join("/home/user", ".trace", "trace.sqlite"),
    );
  });

  test("falls back to ~/.trace/trace.sqlite when TRACE_DB is empty string", () => {
    expect(resolveDbPath({ TRACE_DB: "", HOME: "/home/user" })).toBe(
      join("/home/user", ".trace", "trace.sqlite"),
    );
  });

  test("throws when both TRACE_DB and HOME are absent", () => {
    expect(() => resolveDbPath({})).toThrow();
  });
});
