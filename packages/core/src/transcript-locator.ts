import type { SessionTool } from "./types.ts";

// A Session's `transcriptPath` slot carries a *transcript locator*: either the
// absolute path of a real on-disk transcript, or — for sessions with no
// transcript file — a synthetic `<tool>:<id>` reference. This module is the
// single owner of that string convention. `inferSessionIdentity` mints the
// synthetic form, the store recognizes it when a real path arrives later, and
// the cursor adapter and resume command unpack it — none of them re-derive the
// shape.

export function syntheticLocator(tool: SessionTool, id: string): string {
  return `${tool}:${id}`;
}

export function isSyntheticLocator(locator: string, tool: SessionTool): boolean {
  return locator.startsWith(`${tool}:`);
}

// Cursor sessions come in two flavors, told apart by their locator:
//
// - `composer` — a GUI composer living in the state.vscdb SQLite store, keyed
//   by composerId. No on-disk transcript exists, so the locator is the
//   synthetic `cursor:<composerId>` (a bare composerId is also accepted).
// - `agent-transcript` — a cursor-agent (CLI) chat with a real JSONL
//   transcript under `~/.cursor/projects/<key>/agent-transcripts/<chatId>/`,
//   located by that absolute path.
export type CursorLocatorFlavor = "composer" | "agent-transcript";

export function cursorLocatorFlavor(locator: string): CursorLocatorFlavor {
  return !isSyntheticLocator(locator, "cursor") && locator.endsWith(".jsonl")
    ? "agent-transcript"
    : "composer";
}

/** Unpack a composer-flavor locator; a bare composerId passes through. */
export function composerIdFromLocator(locator: string): string {
  return isSyntheticLocator(locator, "cursor")
    ? locator.slice("cursor:".length)
    : locator;
}
