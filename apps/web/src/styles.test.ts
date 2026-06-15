import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const stylesPath = fileURLToPath(new URL("./index.css", import.meta.url));
const css = readFileSync(stylesPath, "utf8");

const HEX = /#[0-9a-fA-F]{3,8}\b/;
// A line that simply defines a custom property to a hex value, e.g.
//   --color-bg: #0f1419;
const TOKEN_DEFINITION = /^\s*--[\w-]+:\s*#[0-9a-fA-F]{3,8};\s*$/;

test("no hardcoded hex colors remain outside custom-property definitions", () => {
  const offenders = css
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => HEX.test(line) && !TOKEN_DEFINITION.test(line));

  expect(offenders).toEqual([]);
});

test("light and dark palettes are both defined as custom properties", () => {
  expect(css).toContain(":root {");
  expect(css).toContain('[data-theme="dark"]');
  // Every palette token defined in :root must also be overridden for dark.
  const lightTokens = [...css.matchAll(/(--color-[\w-]+):/g)].map((m) => m[1]);
  const darkBlock = css.slice(css.indexOf('[data-theme="dark"]'));
  for (const token of new Set(lightTokens)) {
    expect(darkBlock).toContain(`${token}:`);
  }
});
