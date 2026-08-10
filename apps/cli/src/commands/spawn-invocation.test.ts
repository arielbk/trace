import { expect, test } from "vitest";
import { spawnInvocation } from "./spawn-invocation.ts";

test("on Windows the command carries its arguments and the args array is empty", () => {
  // Node emits DEP0190 for any non-empty args array spawned with `shell: true`,
  // so on Windows the arguments have to be folded into the command string.
  expect(spawnInvocation("win32", "npm", ["install", "-g", "@arielbk/trace@1.2.3"])).toEqual({
    command: "npm install -g @arielbk/trace@1.2.3",
    args: [],
    shell: true,
  });
});

test("on POSIX the command keeps its argument array and no shell", () => {
  expect(spawnInvocation("darwin", "pnpm", ["add", "-g", "@arielbk/trace@1.2.3"])).toEqual({
    command: "pnpm",
    args: ["add", "-g", "@arielbk/trace@1.2.3"],
    shell: false,
  });
});

test("on Windows a command path containing spaces is quoted as one argument", () => {
  // The CLI path comes from the Integration Registry and lives under the user's
  // profile directory, which routinely contains a space.
  const cliPath = "C:\\Users\\Ariel Buchwald\\AppData\\Roaming\\npm\\trace.cmd";
  expect(spawnInvocation("win32", cliPath, ["setup", "--registered", "--yes"])).toEqual({
    command: `"${cliPath}" setup --registered --yes`,
    args: [],
    shell: true,
  });
});

test("on Windows an argument containing spaces is quoted too", () => {
  expect(spawnInvocation("win32", "trace.cmd", ["--root", "C:\\Program Files\\repo"])).toEqual({
    command: `trace.cmd --root "C:\\Program Files\\repo"`,
    args: [],
    shell: true,
  });
});

test("on POSIX spaces are left alone — there is no shell to split them", () => {
  const cliPath = "/Users/ariel/Application Support/npm/trace";
  expect(spawnInvocation("linux", cliPath, ["setup", "--registered"])).toEqual({
    command: cliPath,
    args: ["setup", "--registered"],
    shell: false,
  });
});
