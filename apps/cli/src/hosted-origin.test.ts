import { expect, test } from "vitest";
import { resolveAllowedWebOrigin } from "./serve.ts";

test("hosted access defaults to the official app, with one exact override", () => {
  expect(resolveAllowedWebOrigin({})).toBe("https://app.eqnx.ai");
  expect(resolveAllowedWebOrigin({ TRACE_WEB_ORIGIN: " https://preview.example/ " })).toBe("https://preview.example");
});

test.each(["", " ", "http://app.eqnx.ai", "https://app.eqnx.ai/path", "https://app.eqnx.ai?x=1", "https://app.eqnx.ai#fragment", "https://user:pass@app.eqnx.ai", "*"])("invalid or disabled override %j never falls back to the official app", (origin) => {
  expect(resolveAllowedWebOrigin({ TRACE_WEB_ORIGIN: origin })).toBeUndefined();
});
