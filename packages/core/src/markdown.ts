import { Renderer, parse, parseInline } from "marked";
import type { Tokens } from "marked";

function createLinkSafeRenderer(): Renderer {
  const renderer = new Renderer();
  renderer.link = function link(token: Tokens.Link): string {
    if (hasUnsafeProtocol(token.href)) {
      return this.parser.parseInline(token.tokens);
    }

    return Renderer.prototype.link.call(this, token);
  };

  return renderer;
}

export function renderMarkdown(text: string): string {
  // A fresh renderer per call keeps the checkbox index counter (which marked
  // increments in document order) scoped to this render.
  const renderer = createLinkSafeRenderer();
  let checkboxIndex = 0;
  renderer.checkbox = function checkbox(token: Tokens.Checkbox): string {
    const index = checkboxIndex++;
    const checkedAttr = token.checked ? 'checked="" ' : "";
    return `<input ${checkedAttr}data-checkbox-index="${index}" type="checkbox"> `;
  };

  return parse(text.trim(), {
    async: false,
    breaks: false,
    renderer,
  }).trim();
}

export function renderInlineMarkdown(text: string): string {
  return parseInline(text.trim(), {
    async: false,
    renderer: createLinkSafeRenderer(),
  });
}

const TASK_LIST_MARKER = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/gm;

/**
 * Flip the Nth GFM task-list marker (`[ ]`/`[x]`) in `markdown` to `checked`,
 * counting markers in document order (matching `renderMarkdown`'s indexing).
 * Returns the markdown unchanged when `index` is out of range; preserves all
 * surrounding bytes and whitespace.
 */
export function toggleTaskListCheckbox(
  markdown: string,
  index: number,
  checked: boolean,
): string {
  if (index < 0) return markdown;

  let current = 0;
  return markdown.replace(TASK_LIST_MARKER, (match, bullet: string) => {
    if (current++ !== index) return match;
    return `${bullet}[${checked ? "x" : " "}]`;
  });
}

function hasUnsafeProtocol(href: string): boolean {
  const protocolMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim());
  if (!protocolMatch) return false;

  const protocol = protocolMatch[1]?.toLowerCase();
  return protocol !== "http" && protocol !== "https";
}
