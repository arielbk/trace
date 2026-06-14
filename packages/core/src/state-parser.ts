import { Renderer, parseInline } from "marked";
import type { Tokens } from "marked";

export type ParsedStateMd = {
  summary?: string;
  decisions: string[];
  currentState: string[];
  nextStep?: string;
  openQuestions: string[];
};

type StateSection = "decisions" | "currentState" | "nextStep" | "openQuestions";

const sectionNames = new Map<string, StateSection>([
  ["decisions made", "decisions"],
  ["decisions", "decisions"],
  ["current state", "currentState"],
  ["next step", "nextStep"],
  ["open questions", "openQuestions"],
]);

const linkSafeRenderer = new Renderer();
linkSafeRenderer.link = function link(token: Tokens.Link): string {
  if (hasUnsafeProtocol(token.href)) {
    return this.parser.parseInline(token.tokens);
  }

  return Renderer.prototype.link.call(this, token);
};

export function parseStateMd(text: string): ParsedStateMd {
  const result: ParsedStateMd = {
    decisions: [],
    currentState: [],
    openQuestions: [],
  };
  const body = stripFooter(text);
  const lines = body.split(/\r?\n/);
  let summary: string | undefined;
  const sections = new Map<StateSection, string[]>();
  let currentSection: StateSection | undefined;
  const preamble: string[] = [];

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);

    if (heading) {
      const depth = heading[1]?.length ?? 0;
      const title = heading[2]?.trim() ?? "";

      if (depth === 1 && !summary) {
        summary = title;
        currentSection = undefined;
        continue;
      }

      if (depth === 2) {
        currentSection = sectionNames.get(normalizeHeading(title));
        if (currentSection && !sections.has(currentSection)) {
          sections.set(currentSection, []);
        }
        continue;
      }
    }

    if (currentSection) {
      sections.get(currentSection)?.push(line);
    } else {
      preamble.push(line);
    }
  }

  const fallbackSummary = firstContentLine(preamble);
  const summaryText = summary ?? fallbackSummary;
  if (summaryText) {
    result.summary = renderInline(summaryText);
  }

  result.decisions = parseListOrParagraphs(sections.get("decisions") ?? []);
  result.currentState = parseParagraphs(sections.get("currentState") ?? []);
  result.nextStep = parseFirstParagraph(sections.get("nextStep") ?? []);
  result.openQuestions = parseListOrParagraphs(
    sections.get("openQuestions") ?? [],
  );

  return result;
}

function stripFooter(text: string): string {
  return text.split(/\r?\n---+\s*(?:\r?\n|$)/)[0] ?? "";
}

function normalizeHeading(text: string): string {
  return text.trim().toLowerCase().replace(/[.:]+$/g, "");
}

function firstContentLine(lines: string[]): string | undefined {
  return lines.map((line) => line.trim()).find((line) => line.length > 0);
}

function parseListOrParagraphs(lines: string[]): string[] {
  const items = lines
    .map((line) => /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));

  const values = items.length > 0 ? items : splitParagraphs(lines);
  return values.filter(isMeaningfulValue).map(renderInline);
}

function parseParagraphs(lines: string[]): string[] {
  return splitParagraphs(lines).filter(isMeaningfulValue).map(renderInline);
}

function parseFirstParagraph(lines: string[]): string | undefined {
  const paragraph = splitParagraphs(lines).find(isMeaningfulValue);
  return paragraph ? renderInline(paragraph) : undefined;
}

function splitParagraphs(lines: string[]): string[] {
  return lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

function isMeaningfulValue(text: string): boolean {
  return !/^(?:none|n\/a)$/i.test(text.trim());
}

function renderInline(text: string): string {
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
