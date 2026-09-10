import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { openTraceStore, resolveTaskDocsDir } from "@trace/core";
import { requestAutomaticSync, runSyncCommand } from "./commands/sync.ts";
import { createLocalAuthService } from "./local-auth.ts";
import type { LocalAuthService } from "@trace/core";
import {
  createServeRequestListener,
  startTraceServe,
  type StartTraceServeOptions,
} from "./serve.ts";
import { openConnectionCredentials } from "./connection-credentials.ts";
import type { FakeCloud } from "./fake-sync-server.ts";
import type { CommandResult, Env } from "./commands/seam.ts";

/**
 * The furniture the second-machine journey's tests share: two local runtimes
 * with their own HOMEs, databases and document trees, and a hosted board
 * pointed at either of them.
 *
 * Test-only, like {@link FakeCloud} beside it — nothing here is reachable from
 * `trace.ts`. It lives in its own file because the setup slices and the
 * interruption slices need the same two machines, and a second copy of this
 * would be a second definition of what "machine B" means.
 */

export interface Machine {
  home: string;
  db: string;
  env: Env;
}

/** A local runtime rooted under `root`, pointed at `cloudUrl`. */
export function machine(root: string, name: string, cloudUrl: string): Machine {
  const home = join(root, name, "home");
  mkdirSync(join(home, ".trace"), { recursive: true });
  const db = join(root, name, "trace.sqlite");
  return { home, db, env: { HOME: home, TRACE_DB: db, TRACE_SERVER_URL: cloudUrl } };
}

/** Hand the event loop a turn — what a board tab's poll does between reads. */
export const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(() => resolve()));

/**
 * Sign a machine in the way an already-established one is: bearer token and
 * master key on disk, no login flow. Machine A starts here; machine B arrives
 * here the moment its restore finishes, and stays there across restarts.
 */
export function signInDirectly(m: Machine, token: string, masterKey: string): void {
  writeFileSync(join(m.home, ".trace", "auth.json"), JSON.stringify({ accessToken: token }));
  writeFileSync(join(m.home, ".trace", "key.json"), JSON.stringify({ masterKey }));
}

/**
 * Machine A: signed in the way an established machine is, with one task and one
 * encrypted document already in the cloud. The journey is about *recovering*
 * work, so there has to be work to recover.
 */
export async function machineAWithSyncedWork(
  root: string,
  cloud: FakeCloud,
  token: string,
  masterKey: string,
): Promise<{ a: Machine; slug: string }> {
  const a = machine(root, "a", cloud.url);
  signInDirectly(a, token, masterKey);
  const store = openTraceStore(a.db);
  const task = store.createTask("Ship the second machine");
  store.close();
  const docs = resolveTaskDocsDir(a.db, task.slug);
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "state.md"), "# Ship it\n\nA wrote this.\n");
  const synced = await runSyncCommand(a.env, { fetch: cloud.fetch });
  if (synced.exitCode !== 0) throw new Error("machine A could not sync its work");
  return { a, slug: task.slug };
}

/** Poll a value the way a board tab does, yielding between reads. */
export async function until<T>(
  read: () => T,
  predicate: (value: T) => boolean,
): Promise<T> {
  for (let poll = 0; poll < 1_000; poll += 1) {
    const value = read();
    if (predicate(value)) return value;
    await tick();
  }
  throw new Error(`never settled: ${JSON.stringify(read())}`);
}

/** The same, for a value that has to be fetched. */
export async function untilView<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  for (let poll = 0; poll < 1_000; poll += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await tick();
  }
  throw new Error(`view never settled: ${JSON.stringify(await read())}`);
}

export const HOSTED_ORIGIN = "https://board.test";

export type Captured = { status: number; body: string };

export interface HostedBoard {
  request: (method: string, path: string, body?: string) => Promise<Captured>;
  /** This browser's paired credential, so a restarted service can be revisited
   * by the same browser rather than by a freshly paired one. */
  browserToken: string;
  /** The machine-local service behind this board — the thing that outlives the
   * browser, and the seam a revoked browser must not be able to reach. */
  service: LocalAuthService;
  /** Every sync a completed login on this machine asked for. */
  syncs: Promise<unknown>[];
  /** Every response body this board has been sent, for "no key crossed here". */
  seen: string[];
  /** Stop trusting this browser, the way `eqnx connection revoke` does. */
  revoke: () => void;
}

/**
 * A hosted board pointed at one machine's local EQNX, carrying the hosted
 * origin and a paired browser credential on every request — so the
 * cross-origin allowlist and the capability grant are on the exercised path,
 * not assumed.
 */
export function hostedBoard(
  m: Machine,
  cloud: FakeCloud,
  options: { browserToken?: string } = {},
): HostedBoard {
  const syncs: Promise<unknown>[] = [];
  const seen: string[] = [];
  const connection = openConnectionCredentials({ HOME: m.home });
  // Reopening a board after the service restarted must not mint a second
  // pairing — the browser comes back with the credential it already had.
  const issued = options.browserToken
    ? undefined
    : connection.issueBrowserToken("Test browser");
  const token = options.browserToken ?? issued!.token;
  const id = issued?.id;
  const service = createLocalAuthService(m.env, {
    fetch: cloud.fetch,
    sleep: tick,
    onLoginComplete: () => {
      syncs.push(runSyncCommand(m.env, { fetch: cloud.fetch }));
    },
  });
  const listener = createServeRequestListener(
    m.db,
    undefined,
    true,
    undefined,
    undefined,
    service,
    HOSTED_ORIGIN,
    connection,
  );

  const request = (method: string, path: string, body?: string): Promise<Captured> =>
    new Promise((resolve) => {
      const captured: Captured = { status: 200, body: "" };
      const res = {
        set statusCode(value: number) {
          captured.status = value;
        },
        get statusCode() {
          return captured.status;
        },
        setHeader() {},
        end(chunk?: Buffer | string) {
          captured.body = chunk === undefined ? "" : chunk.toString("utf8");
          seen.push(captured.body);
          resolve(captured);
        },
      } as unknown as ServerResponse;

      const req = Object.assign(new EventEmitter(), {
        method,
        url: path,
        headers: {
          host: "127.0.0.1:4317",
          origin: HOSTED_ORIGIN,
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      }) as unknown as IncomingMessage;
      listener(req, res);
      if (method === "POST") {
        if (body !== undefined) req.emit("data", Buffer.from(body));
        req.emit("end");
      }
    });

  return {
    request,
    browserToken: token,
    service,
    syncs,
    seen,
    revoke: () => {
      if (id) connection.revokeBrowser(id);
    },
  };
}

/**
 * A machine's own long-running local EQNX: the process that keeps syncing after
 * every board is closed.
 *
 * Sync goes through the real {@link requestAutomaticSync} chain — the AutoSync
 * policy, the spawned process's environment handoff, and the execution-boundary
 * check inside the child — with the child executed in-process so a test can
 * await it. Nothing about the scheduling is stubbed: what a test advances is the
 * clock, and what it counts is the syncs the runtime decided to run.
 */
export interface LocalRuntime {
  /** Every sync this runtime's own scheduling has started. */
  syncs: Promise<CommandResult>[];
  /** Await the syncs started so far, the way the next board read does. */
  settle: () => Promise<CommandResult[]>;
  close: () => Promise<void>;
}

export async function startLocalRuntime(
  m: Machine,
  fetch: typeof globalThis.fetch,
  options: { periodicSync?: boolean } = {},
): Promise<LocalRuntime> {
  const syncs: Promise<CommandResult>[] = [];
  const running = await startTraceServe(m.env, {
    ...options,
    server: fakeSocket(),
    triggerSync: (env) =>
      requestAutomaticSync(env as Env, {
        executable: "trace",
        spawn: (_command, _args, spawned) => {
          syncs.push(runSyncCommand(spawned.env as Env, { fetch }));
          return { on: () => undefined, unref: () => undefined };
        },
      }),
  });
  return {
    syncs,
    settle: () => Promise.all([...syncs]),
    close: () => running.close(),
  };
}

/** A `node:http` Server stand-in: the unit environment cannot bind sockets. */
function fakeSocket(): NonNullable<StartTraceServeOptions["server"]> {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    listen: (_port: number, _host: string, onListening: () => void) => {
      onListening();
      return emitter;
    },
    address: () => ({ port: 4317 }),
    close: (onClose?: (error?: Error) => void) => onClose?.(),
  }) as never;
}
