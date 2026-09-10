import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readConfigFile,
  resolveDatabasePath,
  writeConfigFile,
} from "@trace/core";
import { interactiveSetupOperation } from "./setup-interactive.ts";
import type { SetupPrompt, PromptResult } from "./setup-prompt.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture(
  answer: PromptResult<string> = {
    cancelled: false,
    value: "https://sync.example.test/",
  },
  confirm = true,
) {
  const home = mkdtempSync(join(tmpdir(), "eqnx-setup-server-"));
  homes.push(home);
  mkdirSync(join(home, ".codex"));
  const env: Record<string, string> = {
    HOME: home,
    TRACE_CLI_PATH: "/opt/bin/eqnx",
  };
  let asked = 0;
  const prompt: SetupPrompt & { serverUrl(): Promise<PromptResult<string>> } = {
    async selectTargets(request) {
      return { cancelled: false, value: request.initialValues };
    },
    async confirm() {
      return { cancelled: false, value: confirm };
    },
    async serverUrl() {
      asked++;
      return answer;
    },
    note() {},
    warn() {},
  };
  return {
    home,
    env,
    prompt,
    asked: () => asked,
    run: () => interactiveSetupOperation({ env, cwd: home, stdin: "" }, prompt),
  };
}

test("fresh setup saves the entered sync server after confirming installation", async () => {
  const f = fixture();
  expect(readConfigFile(resolveDatabasePath(f.env))).toBeNull();
  const result = await f.run();
  expect(result.exitCode).toBe(0);
  expect(f.asked()).toBe(1);
  expect(readConfigFile(resolveDatabasePath(f.env))?.serverUrl).toBe(
    "https://sync.example.test",
  );
});

test("cancelling setup never saves the offered server or installs integrations", async () => {
  const f = fixture(undefined, false);
  expect((await f.run()).stdout).toContain("cancelled");
  expect(readConfigFile(resolveDatabasePath(f.env))).toBeNull();
});

test("cancelling the server prompt leaves setup unchanged", async () => {
  const f = fixture({ cancelled: true });
  expect((await f.run()).stdout).toContain("cancelled");
  expect(readConfigFile(resolveDatabasePath(f.env))).toBeNull();
});

test("leaving the server blank keeps a local-only installation", async () => {
  const f = fixture({ cancelled: false, value: "  " });
  expect((await f.run()).exitCode).toBe(0);
  expect(readConfigFile(resolveDatabasePath(f.env))).toBeNull();
});

test("setup preserves a configured server and automatic-sync policy without asking again", async () => {
  const f = fixture();
  writeConfigFile(resolveDatabasePath(f.env), {
    serverUrl: "https://custom.example.test",
    autoSync: false,
  });
  expect((await f.run()).exitCode).toBe(0);
  expect(f.asked()).toBe(0);
  expect(readConfigFile(resolveDatabasePath(f.env))).toEqual({
    serverUrl: "https://custom.example.test",
    autoSync: false,
  });
});

test("setup respects an environment override without persisting it", async () => {
  const f = fixture();
  f.env.TRACE_SERVER_URL = "https://override.example.test";
  expect((await f.run()).exitCode).toBe(0);
  expect(f.asked()).toBe(0);
  expect(readConfigFile(resolveDatabasePath(f.env))).toBeNull();
});

test("an invalid server is refused before setup writes", async () => {
  const f = fixture({ cancelled: false, value: "file:///tmp/server" });
  expect((await f.run()).exitCode).not.toBe(0);
  expect(readConfigFile(resolveDatabasePath(f.env))).toBeNull();
});
