import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runTraceCli } from "../trace.ts";
import {
  configGetOperation,
  configSetOperation,
  configUnsetOperation,
} from "./config-operations.ts";

function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "trace-config-home-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("config set/get/unset round-trips server-url beside the database", () => {
  const { home, cleanup } = tempHome();
  const env = { HOME: home };
  try {
    expect(
      configSetOperation(["server-url", "https://sync.test/"], { env }),
    ).toEqual({ exitCode: 0, stdout: "server-url set\n", stderr: "" });

    expect(
      JSON.parse(readFileSync(join(home, ".trace", "config.json"), "utf8")),
    ).toEqual({ serverUrl: "https://sync.test" });

    expect(configGetOperation(["server-url"], { env })).toEqual({
      exitCode: 0,
      stdout: "https://sync.test\n",
      stderr: "",
    });

    expect(configUnsetOperation(["server-url"], { env })).toEqual({
      exitCode: 0,
      stdout: "server-url unset\n",
      stderr: "",
    });
    expect(configGetOperation(["server-url"], { env }).exitCode).toBe(1);
  } finally {
    cleanup();
  }
});

test("config get reports an unset key on exit code 1", () => {
  const { home, cleanup } = tempHome();
  try {
    expect(configGetOperation(["server-url"], { env: { HOME: home } })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "server-url is not set\n",
    });
  } finally {
    cleanup();
  }
});

test("config set rejects malformed and non-http URLs", () => {
  const { home, cleanup } = tempHome();
  const env = { HOME: home };
  try {
    const notAUrl = configSetOperation(["server-url", "not a url"], { env });
    expect(notAUrl.exitCode).toBe(2);
    expect(notAUrl.stderr).toContain("not a valid URL");

    const wrongScheme = configSetOperation(
      ["server-url", "ftp://sync.test"],
      { env },
    );
    expect(wrongScheme.exitCode).toBe(2);
    expect(wrongScheme.stderr).toContain("http:// or https://");
  } finally {
    cleanup();
  }
});

test("config commands reject unknown keys and list the known ones", () => {
  const { home, cleanup } = tempHome();
  try {
    const result = configGetOperation(["nonsense"], { env: { HOME: home } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown config key "nonsense"');
    expect(result.stderr).toContain("server-url");
  } finally {
    cleanup();
  }
});

test("trace config dispatches through the CLI entry", () => {
  const { home, cleanup } = tempHome();
  try {
    const set = runTraceCli(
      ["config", "set", "server-url", "https://sync.test"],
      { HOME: home },
    );
    expect(set.exitCode).toBe(0);

    const get = runTraceCli(["config", "get", "server-url"], { HOME: home });
    expect(get).toEqual({
      exitCode: 0,
      stdout: "https://sync.test\n",
      stderr: "",
    });
  } finally {
    cleanup();
  }
});
