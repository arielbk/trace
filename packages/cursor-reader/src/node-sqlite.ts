import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

type NodeSqliteModule = typeof import("node:sqlite");

/** The Node built-in SQLite class type, used for annotations. */
export type DatabaseSync = NodeDatabaseSync;

let cachedClass: NodeSqliteModule["DatabaseSync"] | undefined;

/**
 * Lazily resolve Node's built-in `node:sqlite` class. Loading is deferred to
 * first use rather than running at module load so that importing the
 * `@trace/cursor-reader` barrel stays side-effect free (mirrors the wrapper in
 * `@trace/core`). Cursor's databases are large and held open by a running
 * Cursor, so all reads go through here with read-only access.
 */
export function getDatabaseSync(): NodeSqliteModule["DatabaseSync"] {
  if (!cachedClass) {
    const require = createRequire(import.meta.url);
    cachedClass = (require("node:sqlite") as NodeSqliteModule).DatabaseSync;
  }
  return cachedClass;
}
