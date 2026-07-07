import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveDatabasePath } from "./db-path.ts";

describe("resolveDatabasePath", () => {
  test("returns TRACE_DB when set", () => {
    expect(resolveDatabasePath({ TRACE_DB: "/custom/path/trace.sqlite" })).toBe(
      "/custom/path/trace.sqlite",
    );
  });

  test("falls back to ~/.trace/trace.sqlite when TRACE_DB is unset", () => {
    expect(resolveDatabasePath({ HOME: "/home/user" })).toBe(
      join("/home/user", ".trace", "trace.sqlite"),
    );
  });

  test("falls back to ~/.trace/trace.sqlite when TRACE_DB is empty string", () => {
    expect(resolveDatabasePath({ TRACE_DB: "", HOME: "/home/user" })).toBe(
      join("/home/user", ".trace", "trace.sqlite"),
    );
  });

  test("throws when both TRACE_DB and HOME are absent", () => {
    expect(() => resolveDatabasePath({})).toThrow();
  });
});
