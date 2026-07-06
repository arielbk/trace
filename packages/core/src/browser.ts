/**
 * Browser-safe surface of `@trace/core`.
 *
 * The main barrel (`.`) re-exports `store.ts`, which statically imports Node
 * built-ins (`node:sqlite`, `node:crypto`, `node:fs`). Those get externalized
 * in a browser bundle and throw on access, so the web client must not import
 * the barrel. This entry exposes only the pure value/type helpers the client
 * needs — no Node built-ins are reachable from here.
 */
export {
  addTokenTotals,
  emptyTokenTotals,
  freshTokenTotal,
  tokenTotalsFromUsage,
} from "./token-totals.ts";
export type { RawTokenUsage } from "./token-totals.ts";
export type {
  ActiveTask,
  RegisterSessionInput,
  ReEntryManifest,
  ReEntryManifestDoc,
  ReEntryManifestSession,
  Session,
  SessionTool,
  Task,
  TaskDoc,
  TaskStore,
  TaskSummary,
  TaskTimeline,
  TaskTimelineItem,
  TokenTotals,
} from "./types.ts";
export { resumeCommand } from "./resume-command.ts";
export {
  composerIdFromLocator,
  cursorLocatorFlavor,
  isSyntheticLocator,
  syntheticLocator,
} from "./transcript-locator.ts";
export type { CursorLocatorFlavor } from "./transcript-locator.ts";
