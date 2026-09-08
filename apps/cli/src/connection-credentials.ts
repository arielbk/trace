import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readBridgeCredential } from "./bridge-credential.ts";

type Env = Record<string, string | undefined>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A paired browser as it is persisted: digest only, never the token. */
type BrowserRecord = {
  id: string;
  digest: string;
  label: string;
  pairedAt: string;
};

/** Persisted local connection state: one management credential plus the
 * browsers this installation has paired, recorded by digest only. */
type ConnectionState = {
  version: 1;
  management: string;
  browsers: BrowserRecord[];
  /** True once the pre-per-browser `bridge.json` credential has been folded in,
   * so revoking that legacy browser is final. */
  legacyMigrated?: boolean;
};

/** How the migrated `bridge.json` credential appears in `trace connection
 * browsers` — it authorizes every browser paired before per-browser tokens. */
export const LEGACY_BROWSER_LABEL = "Browsers paired before this version";

/** What a browser record may be shown as — no digest, no token material. */
export type PairedBrowser = {
  id: string;
  label: string;
  pairedAt: string;
};

export type ConnectionCredentials = {
  /** The local admin credential the management routes require. */
  readonly managementToken: string;
  /** Mint a fresh persistent credential for one browser. */
  issueBrowserToken(label: string): { id: string; token: string };
  /** Resolve a browser credential to its record, or null when unknown. */
  verifyBrowserToken(token: string): PairedBrowser | null;
  listBrowsers(): PairedBrowser[];
  /** Revoke one browser; false when no such browser is paired. */
  revokeBrowser(id: string): boolean;
  /** Revoke every browser credential, preserving management access. */
  reset(): void;
};

export function resolveConnectionCredentialsPath(env: Env): string {
  return join(env.HOME ?? homedir(), ".trace", "connection.json");
}

/** Open — creating on first use — this installation's connection state. */
export function openConnectionCredentials(env: Env): ConnectionCredentials {
  const path = resolveConnectionCredentialsPath(env);
  const state = migrateLegacyCredential(
    path,
    readState(path) ?? createState(path),
    env,
  );

  // Every read goes back to disk so a revocation performed by another process
  // takes effect on the very next request, rather than at the next restart.
  const current = (): ConnectionState => readState(path) ?? createState(path);

  return {
    managementToken: state.management,

    issueBrowserToken(label: string): { id: string; token: string } {
      const token = randomBytes(32).toString("base64url");
      const record: BrowserRecord = {
        id: randomBytes(6).toString("base64url"),
        digest: digestOf(token),
        label,
        pairedAt: new Date().toISOString(),
      };
      const next = current();
      writeState(path, { ...next, browsers: [...next.browsers, record] });
      return { id: record.id, token };
    },

    verifyBrowserToken(token: string): PairedBrowser | null {
      const supplied = digestOf(token);
      const matched = current().browsers.find((browser) =>
        digestsMatch(supplied, browser.digest),
      );
      return matched ? safeBrowser(matched) : null;
    },

    listBrowsers(): PairedBrowser[] {
      return current().browsers.map(safeBrowser);
    },

    revokeBrowser(id: string): boolean {
      const next = current();
      const browsers = next.browsers.filter((browser) => browser.id !== id);
      if (browsers.length === next.browsers.length) return false;
      writeState(path, { ...next, browsers });
      return true;
    },

    reset(): void {
      writeState(path, { ...current(), browsers: [] });
    },
  };
}

function safeBrowser({ id, label, pairedAt }: BrowserRecord): PairedBrowser {
  return { id, label, pairedAt };
}

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function digestsMatch(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

/**
 * Fold this installation's pre-existing `bridge.json` credential into the
 * browser list once, so browsers paired before per-browser tokens keep working
 * until the user revokes or resets. The migration is recorded rather than
 * inferred from the browser list, so a revoked legacy record stays revoked.
 */
function migrateLegacyCredential(
  path: string,
  state: ConnectionState,
  env: Env,
): ConnectionState {
  if (state.legacyMigrated) return state;
  const legacyToken = readBridgeCredential(env);
  const migrated: ConnectionState = {
    ...state,
    legacyMigrated: true,
    browsers: legacyToken
      ? [
          ...state.browsers,
          {
            id: randomBytes(6).toString("base64url"),
            digest: digestOf(legacyToken),
            label: LEGACY_BROWSER_LABEL,
            pairedAt: new Date().toISOString(),
          },
        ]
      : state.browsers,
  };
  writeState(path, migrated);
  return migrated;
}

function createState(path: string): ConnectionState {
  const state: ConnectionState = {
    version: 1,
    management: randomBytes(32).toString("base64url"),
    browsers: [],
  };
  writeState(path, state);
  return state;
}

function readState(path: string): ConnectionState | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Invalid Trace connection state at ${path}`);
  }
  const candidate = parsed as Partial<ConnectionState>;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    candidate.version !== 1 ||
    typeof candidate.management !== "string" ||
    !TOKEN_PATTERN.test(candidate.management) ||
    !Array.isArray(candidate.browsers)
  ) {
    throw new Error(`Invalid Trace connection state at ${path}`);
  }
  return candidate as ConnectionState;
}

function writeState(path: string, state: ConnectionState): void {
  const directory = join(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}
