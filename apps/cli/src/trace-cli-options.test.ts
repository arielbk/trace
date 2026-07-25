import { expect, test } from "vitest";
import { traceCliOptionsFor } from "./trace.ts";

test("a terminal on both streams gets an interactive session with a prompt adapter", () => {
  const options = traceCliOptionsFor({
    stdin: { isTTY: true },
    stdout: { isTTY: true },
  });

  expect(options.interactive).toBe(true);
  expect(options.createPrompt).toBeTypeOf("function");

  const prompt = options.createPrompt?.();
  expect(prompt?.selectTargets).toBeTypeOf("function");
  expect(prompt?.confirmInstall).toBeTypeOf("function");
  expect(prompt?.note).toBeTypeOf("function");
});

test("a redirected stream keeps the session non-interactive", () => {
  expect(
    traceCliOptionsFor({ stdin: { isTTY: false }, stdout: { isTTY: true } })
      .interactive,
  ).toBe(false);
  expect(
    traceCliOptionsFor({ stdin: { isTTY: true }, stdout: { isTTY: undefined } })
      .interactive,
  ).toBe(false);
});
