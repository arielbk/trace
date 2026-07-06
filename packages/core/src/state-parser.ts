import { renderInlineMarkdown, renderMarkdown } from "./markdown.ts";

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
    result.summary = renderInlineMarkdown(summaryText);
  }

  result.decisions = parseListOrParagraphs(sections.get("decisions") ?? []);
  result.currentState = parseBlocks(sections.get("currentState") ?? []);
  result.nextStep = parseFirstBlock(sections.get("nextStep") ?? []);
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
  const items: string[] = [];
  let current: string | undefined;
  let sawList = false;

  for (const line of lines) {
    const marker = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (marker) {
      sawList = true;
      if (current !== undefined) items.push(current);
      current = marker[1]?.trim() ?? "";
    } else if (current !== undefined) {
      // A wrapped continuation line folds into the current item; a blank line
      // ends it so the next bullet starts a fresh item.
      const continuation = line.trim();
      if (continuation.length === 0) {
        items.push(current);
        current = undefined;
      } else {
        current = `${current} ${continuation}`;
      }
    }
  }
  if (current !== undefined) items.push(current);

  const values = sawList ? items : splitParagraphs(lines);
  return values.filter(isMeaningfulValue).map(renderInlineMarkdown);
}

/**
 * Render the section as block-level markdown, one entry per blank-line-separated
 * block. Unlike paragraph parsing this preserves intra-block newlines, so bullet
 * lists become real <ul><li> instead of being flattened into a run-on paragraph.
 */
function parseBlocks(lines: string[]): string[] {
  return splitBlocks(lines).filter(isMeaningfulValue).map(renderMarkdown);
}

function splitBlocks(lines: string[]): string[] {
  return lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Render the first blank-line-separated block of the section as block-level
 * markdown. Unlike paragraph parsing this preserves intra-block newlines, so a
 * numbered or bulleted "next step" becomes a real list instead of a run-on line.
 */
function parseFirstBlock(lines: string[]): string | undefined {
  const block = splitBlocks(lines).find(isMeaningfulValue);
  return block ? renderMarkdown(block) : undefined;
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
