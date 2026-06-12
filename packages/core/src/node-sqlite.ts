import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

type NodeSqliteModule = typeof import("node:sqlite");

const require = createRequire(import.meta.url);

export type DatabaseSync = NodeDatabaseSync;
export const { DatabaseSync } = require("node:sqlite") as NodeSqliteModule;
