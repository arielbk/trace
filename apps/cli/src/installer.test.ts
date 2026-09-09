import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { runInit } from "./installer.ts";

describe("eqnx init", () => {
  it("reports the CLI-first install path without touching any settings", () => {
    const output = runInit({}, "/tmp");

    assert.equal(output.includes("npm install -g @eqnx/cli"), true);
    assert.equal(output.includes("eqnx setup"), true);
    assert.equal(output.includes("eqnx update"), true);
    assert.equal(output.includes("eqnx setup --remove"), true);
    assert.equal(output.includes("plugin marketplace"), false);
    assert.equal(output.includes("npx @eqnx/cli"), false);
  });

  it("is pure: does not read or write any files", () => {
    const output = runInit({ HOME: "/nonexistent" }, "/nonexistent");

    assert.equal(typeof output, "string");
    assert.equal(output.length > 0, true);
  });
});
