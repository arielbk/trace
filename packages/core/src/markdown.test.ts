import { expect, test } from "vitest";
import { renderMarkdown, toggleTaskListCheckbox } from "./index.ts";

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

test("renderMarkdown reflows single newlines so hard-wrapped prose joins", () => {
  expect(renderMarkdown("line one\nline two")).toBe(
    "<p>line one\nline two</p>",
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

test("renderMarkdown renders task-list checkboxes as interactive, indexed inputs", () => {
  expect(renderMarkdown("- [ ] one\n- [x] two")).toBe(
    "<ul>\n" +
      '<li><input data-checkbox-index="0" type="checkbox"> one</li>\n' +
      '<li><input checked="" data-checkbox-index="1" type="checkbox"> two</li>\n' +
      "</ul>",
  );
});

test("renderMarkdown indexes nested task-list checkboxes in document order", () => {
  expect(
    renderMarkdown("- [ ] top\n  - [x] child\n- [ ] bottom"),
  ).toContain('data-checkbox-index="0"');
  const html = renderMarkdown("- [ ] top\n  - [x] child\n- [ ] bottom");
  expect(html).toContain('data-checkbox-index="0"');
  expect(html).toContain('checked="" data-checkbox-index="1"');
  expect(html).toContain('data-checkbox-index="2"');
  expect(html).not.toContain("disabled");
});

test("renderMarkdown leaves ordinary content unaffected", () => {
  expect(renderMarkdown("- one\n- two")).toBe(
    "<ul>\n<li>one</li>\n<li>two</li>\n</ul>",
  );
});

test("toggleTaskListCheckbox flips the Nth marker on", () => {
  expect(toggleTaskListCheckbox("- [ ] one\n- [ ] two", 1, true)).toBe(
    "- [ ] one\n- [x] two",
  );
});

test("toggleTaskListCheckbox flips the Nth marker off", () => {
  expect(toggleTaskListCheckbox("- [x] one\n- [x] two", 0, false)).toBe(
    "- [ ] one\n- [x] two",
  );
});

test("toggleTaskListCheckbox is idempotent when already in desired state", () => {
  expect(toggleTaskListCheckbox("- [x] one", 0, true)).toBe("- [x] one");
  expect(toggleTaskListCheckbox("- [ ] one", 0, false)).toBe("- [ ] one");
});

test("toggleTaskListCheckbox preserves surrounding bytes and whitespace", () => {
  const md = "# Heading\n\nIntro paragraph.\n\n- [ ] alpha\n- [ ] beta\n\nOutro.\n";
  expect(toggleTaskListCheckbox(md, 1, true)).toBe(
    "# Heading\n\nIntro paragraph.\n\n- [ ] alpha\n- [x] beta\n\nOutro.\n",
  );
});

test("toggleTaskListCheckbox handles nested task lists in document order", () => {
  const md = "- [ ] top\n  - [ ] child\n- [ ] bottom";
  expect(toggleTaskListCheckbox(md, 1, true)).toBe(
    "- [ ] top\n  - [x] child\n- [ ] bottom",
  );
});

test("toggleTaskListCheckbox preserves an uppercase checked marker when toggling others", () => {
  expect(toggleTaskListCheckbox("- [X] one\n- [ ] two", 1, true)).toBe(
    "- [X] one\n- [x] two",
  );
});

test("toggleTaskListCheckbox is a safe no-op for an out-of-range index", () => {
  const md = "- [ ] one\n- [ ] two";
  expect(toggleTaskListCheckbox(md, 5, true)).toBe(md);
  expect(toggleTaskListCheckbox(md, -1, true)).toBe(md);
});
