import { expect, test } from "vitest";
import { renderMarkdown } from "./index.ts";

test("renderMarkdown renders headings", () => {
  expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
});

test("renderMarkdown renders lists", () => {
  expect(renderMarkdown("- one\n- two")).toBe(
    "<ul>\n<li>one</li>\n<li>two</li>\n</ul>",
  );
});

test("renderMarkdown renders emphasis and inline code", () => {
  expect(renderMarkdown("**bold** and `code`")).toBe(
    "<p><strong>bold</strong> and <code>code</code></p>",
  );
});

test("renderMarkdown keeps http/https links as anchors", () => {
  expect(renderMarkdown("[safe](https://example.com)")).toBe(
    '<p><a href="https://example.com">safe</a></p>',
  );
  expect(renderMarkdown("[safe](http://example.com)")).toBe(
    '<p><a href="http://example.com">safe</a></p>',
  );
});

test("renderMarkdown strips unsafe link protocols to plain text", () => {
  expect(renderMarkdown("[bad](javascript:alert(1))")).toBe("<p>bad</p>");
  expect(renderMarkdown("[bad](file:///etc/passwd)")).toBe("<p>bad</p>");
});

test("renderMarkdown turns single newlines into line breaks", () => {
  expect(renderMarkdown("line one\nline two")).toBe(
    "<p>line one<br>line two</p>",
  );
});

test("renderMarkdown keeps double newlines as separate paragraphs", () => {
  expect(renderMarkdown("para one\n\npara two")).toBe(
    "<p>para one</p>\n<p>para two</p>",
  );
});

test("renderMarkdown renders fenced code blocks", () => {
  expect(renderMarkdown("```js\nconsole.log(1);\n```")).toBe(
    '<pre><code class="language-js">console.log(1);\n</code></pre>',
  );
});
