import { Renderer, parse, parseInline } from "marked";
import type { Tokens } from "marked";

const linkSafeRenderer = new Renderer();
linkSafeRenderer.link = function link(token: Tokens.Link): string {
  if (hasUnsafeProtocol(token.href)) {
    return this.parser.parseInline(token.tokens);
  }

  return Renderer.prototype.link.call(this, token);
};

export function renderMarkdown(text: string): string {
  return parse(text.trim(), {
    async: false,
    breaks: false,
    renderer: linkSafeRenderer,
  }).trim();
}

export function renderInlineMarkdown(text: string): string {
  return parseInline(text.trim(), {
    async: false,
    renderer: linkSafeRenderer,
  });
}

function hasUnsafeProtocol(href: string): boolean {
  const protocolMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim());
  if (!protocolMatch) return false;

  const protocol = protocolMatch[1]?.toLowerCase();
  return protocol !== "http" && protocol !== "https";
}
