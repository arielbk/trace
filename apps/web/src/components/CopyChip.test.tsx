import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { CopyChip } from "./CopyChip.tsx";

test("CopyChip renders the truncated display value", () => {
  const html = renderToStaticMarkup(
    <CopyChip value="0e1d2c3b-4a59-6879-8a7b-6c5d4e3f2a1b" display="0e1d2c3b" />,
  );

  expect(html).toContain("0e1d2c3b");
});

test("CopyChip exposes the full value via the title attribute for hover", () => {
  const html = renderToStaticMarkup(
    <CopyChip value="0e1d2c3b-4a59-6879-8a7b-6c5d4e3f2a1b" display="0e1d2c3b" />,
  );

  expect(html).toContain('title="0e1d2c3b-4a59-6879-8a7b-6c5d4e3f2a1b"');
});

test("CopyChip renders as an accessible copy button", () => {
  const html = renderToStaticMarkup(
    <CopyChip value="0e1d2c3b-4a59-6879-8a7b-6c5d4e3f2a1b" display="0e1d2c3b" />,
  );

  expect(html).toContain('type="button"');
  expect(html).toContain('class="copy-chip"');
  expect(html).toContain('aria-label="Copy 0e1d2c3b-4a59-6879-8a7b-6c5d4e3f2a1b"');
});
