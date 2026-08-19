import { expect, test } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { zipExportBundle } from "./export-zip.ts";

test("zipExportBundle round-trips files under a single top-level folder", () => {
  const zipped = zipExportBundle([
    { path: "checkout-2026-08-19/README.md", contents: "# Checkout\n" },
    {
      path: "checkout-2026-08-19/manifest.json",
      contents: '{"formatVersion":1}\n',
    },
    { path: "checkout-2026-08-19/docs/", contents: new Uint8Array() },
    {
      path: "checkout-2026-08-19/docs/state.md",
      contents: new TextEncoder().encode("# State\n"),
    },
  ]);

  const unzipped = unzipSync(zipped);
  const names = Object.keys(unzipped).sort();
  expect(names).toEqual([
    "checkout-2026-08-19/README.md",
    "checkout-2026-08-19/docs/state.md",
    "checkout-2026-08-19/manifest.json",
  ]);
  expect(strFromU8(unzipped["checkout-2026-08-19/README.md"]!)).toBe(
    "# Checkout\n",
  );
  expect(strFromU8(unzipped["checkout-2026-08-19/manifest.json"]!)).toBe(
    '{"formatVersion":1}\n',
  );
  expect(strFromU8(unzipped["checkout-2026-08-19/docs/state.md"]!)).toBe(
    "# State\n",
  );
  expect(new Set(names.map((name) => name.split("/")[0]))).toEqual(
    new Set(["checkout-2026-08-19"]),
  );
});
