import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveDatabasePath } from "./db-path.ts";

/**
 * Persisted beside the Trace database as `config.json`. Machine-local client
 * settings written by `trace config set` — never synced. Living beside the
 * database means a `TRACE_DB` sandbox carries its own config, so a demo or QA
 * store can't accidentally point at the real sync server.
 */
export interface TraceConfigFile {
  /** Base URL of the cloud sync server, e.g. `https://trace.example.com`. */
  serverUrl?: string;
}

/** Location of the config file: `config.json` beside the database. */
export function resolveConfigPath(databasePath: string): string {
  return join(dirname(resolve(databasePath)), "config.json");
}

/** Read the raw config file, or `null` when it is absent or malformed. */
export function readConfigFile(databasePath: string): TraceConfigFile | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolveConfigPath(databasePath), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const config = parsed as TraceConfigFile;
    if (config.serverUrl !== undefined && typeof config.serverUrl !== "string") {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

/** Atomically overwrite the config file. */
export function writeConfigFile(
  databasePath: string,
  config: TraceConfigFile,
): void {
  const path = resolveConfigPath(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

/**
 * Merge a partial patch into the current config file (or an empty base when
 * none exists). `undefined` values in the patch clear the corresponding field,
 * since `JSON.stringify` drops undefined keys — this is how
 * `trace config unset` removes a key.
 */
export function updateConfigFile(
  databasePath: string,
  patch: Partial<TraceConfigFile>,
): void {
  const current = readConfigFile(databasePath) ?? {};
  writeConfigFile(databasePath, { ...current, ...patch });
}

/**
 * The sync server URL the client should talk to, or `undefined` when none is
 * configured. `TRACE_SERVER_URL` is the explicit env override; otherwise the
 * `config.json` beside the database supplies it (`trace config set
 * server-url`). Trailing slashes are stripped so callers can append `/api/...`
 * paths directly. Resolution never throws: with no usable database path there
 * is simply no config file to read.
 */
export function resolveConfiguredServerUrl(
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.TRACE_SERVER_URL) return normalizeServerUrl(env.TRACE_SERVER_URL);
  try {
    const configured = readConfigFile(resolveDatabasePath(env))?.serverUrl;
    return configured ? normalizeServerUrl(configured) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
