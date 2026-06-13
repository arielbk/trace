import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

type NodeSqliteModule = typeof import("node:sqlite");

/** The Node built-in SQLite class type, used for annotations. */
export type DatabaseSync = NodeDatabaseSync;

let cachedClass: NodeSqliteModule["DatabaseSync"] | undefined;

/**
 * Lazily resolve Node's built-in `node:sqlite` class. Loading is deferred to
 * first use rather than running at module load so that importing this module
 * (and therefore the `@trace/core` barrel) stays side-effect free. The browser
 * web bundle pulls in the barrel for shared helpers/types; executing
 * `createRequire`/`require("node:sqlite")` at import time would crash there.
 */
export function getDatabaseSync(): NodeSqliteModule["DatabaseSync"] {
  if (!cachedClass) {
    const require = createRequire(import.meta.url);
    cachedClass = (require("node:sqlite") as NodeSqliteModule).DatabaseSync;
  }
  return cachedClass;
}
