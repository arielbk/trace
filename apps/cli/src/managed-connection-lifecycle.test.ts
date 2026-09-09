import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CONNECTION_ENDPOINT_ORIGIN } from "./connection-address.ts";
import {
  MANAGED_CONNECTION_LABEL,
  restartConnectionService,
  type ConnectionServiceDependencies,
  type LaunchctlResult,
} from "./connection-service.ts";
import { startTraceServe, type TraceServer } from "./serve.ts";
import { boardOperation } from "./commands/board-operations.ts";
import { connectionOperation } from "./commands/connection-operations.ts";
import {
  taskCreateOperation,
  taskListOperation,
} from "./commands/task-operations.ts";
import { setupOperation } from "./commands/setup-operations.ts";
import { updateOperation } from "./commands/update-operations.ts";

const HOSTED_ORIGIN = "https://trace-hosted.example";
const NODE_PATH = "/opt/homebrew/bin/node";
const CLI_PATH = "/opt/global/bin/trace";

/**
 * The whole connection lifecycle, composed: `eqnx setup` installs the login
 * service, launchd runs it, a browser pairs against the process that service
 * started, and every later command talks to that same process over a real
 * socket. Nothing here stubs a EQNX module — the commands, the credential
 * store, the plist and the HTTP server are the production ones. Only the two
 * boundaries EQNX does not own are modelled: launchd, and the fixed endpoint
 * (the connection binds an ephemeral port so the suite never fights whatever
 * holds 4317 on the machine running it).
 */

let home: string;
let current: Machine | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trace-connection-lifecycle-"));
});

afterEach(async () => {
  await current?.shutDown();
  current = undefined;
  rmSync(home, { recursive: true, force: true });
});

/**
 * A machine with launchd modelled and no connection running yet. Without
 * `hosted`, hosted access is explicitly disabled — the bundled-board machine.
 */
function machine(options: { hosted?: boolean } = {}): Machine {
  current = new Machine(
    home,
    options.hosted === false ? undefined : HOSTED_ORIGIN,
  );
  return current;
}

class Machine {
  readonly calls: string[][] = [];
  private loaded = false;
  private running: Promise<TraceServer> | undefined;
  /** The version of EQNX currently on disk at {@link CLI_PATH}. */
  installedVersion = "1.0.0";

  constructor(
    private readonly home: string,
    private readonly hostedOrigin: string | undefined,
  ) {}

  /** The environment an interactive `trace …` invocation sees. */
  get env(): Record<string, string | undefined> {
    return {
      HOME: this.home,
      TRACE_CLI_PATH: CLI_PATH,
      TRACE_CURRENT_VERSION: this.installedVersion,
      TRACE_WEB_ORIGIN: this.hostedOrigin ?? "",
    };
  }

  get plistPath(): string {
    return join(
      this.home,
      "Library",
      "LaunchAgents",
      `${MANAGED_CONNECTION_LABEL}.plist`,
    );
  }

  /** True while launchd is holding the job. */
  get jobLoaded(): boolean {
    return this.loaded;
  }

  /** True while a connection process is answering on the endpoint. */
  get connected(): boolean {
    return this.running !== undefined;
  }

  /**
   * launchd, as far as this installation can observe it: it answers `print`
   * for a job it holds, and `bootstrap`/`kickstart` actually start the process
   * — from the plist on disk, so the job runs with what was written for it.
   */
  get service(): ConnectionServiceDependencies {
    return {
      platform: "darwin",
      uid: 501,
      nodePath: NODE_PATH,
      launchctl: (args) => this.launchctl(args),
    };
  }

  /** The dependency bag every `trace` command in this file is given. */
  get dependencies(): {
    fetch: typeof globalThis.fetch;
    service: ConnectionServiceDependencies;
  } {
    return { fetch: this.fetch, service: this.service };
  }

  /**
   * A logout, a reboot, or a crash: the process goes away and launchd brings
   * the job back from the plist it kept on disk.
   */
  reboot(): void {
    this.stop();
    this.loaded = false;
    this.launchctl(["bootstrap", "gui/501", this.plistPath]);
  }

  async shutDown(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    await running?.then((server) => server.close()).catch(() => {});
  }

  private launchctl(args: string[]): LaunchctlResult {
    this.calls.push(args);
    const notFound = { status: 113, stderr: "Could not find service\n" };
    const ok = { status: 0, stderr: "" };
    switch (args[0]) {
      case "print":
        return this.loaded ? ok : notFound;
      case "bootstrap":
        this.loaded = true;
        // RunAtLoad: launchd starts the job as it takes it on.
        this.launch();
        return ok;
      case "bootout":
        this.loaded = false;
        this.stop();
        return ok;
      case "kickstart":
        if (!this.loaded) return notFound;
        this.launch();
        return ok;
      default:
        return ok;
    }
  }

  /** Start the connection the way the job would: from the plist's own env. */
  private launch(): void {
    this.stop();
    const environment = plistEnvironment(readFileSync(this.plistPath, "utf8"));
    this.running = startTraceServe(
      {
        ...environment,
        // A process runs the executable that was on disk when it started, and
        // goes on running it after a package manager replaces the file.
        TRACE_CURRENT_VERSION: this.installedVersion,
      },
      {
        port: 0,
        allowPortFallback: true,
        localManagement: true,
        // Nothing in this file is about cloud sync, and the real trigger
        // spawns a process.
        triggerSync: () => {},
        periodicSync: false,
      },
    );
  }

  private stop(): void {
    const running = this.running;
    this.running = undefined;
    void running?.then((server) => server.close()).catch(() => {});
  }

  /**
   * The socket a command or a browser reaches the endpoint through. Nothing
   * listening refuses the connection, exactly as `fetch` reports it; a running
   * connection answers on the port it actually bound.
   */
  get fetch(): typeof globalThis.fetch {
    return (async (input: string | URL, init?: RequestInit) => {
      const running = this.running;
      if (!running) throw new TypeError("fetch failed");
      const server = await running;
      const url = new URL(String(input));
      url.port = String(server.port);
      return globalThis.fetch(url, init);
    }) as typeof globalThis.fetch;
  }
}

/** The EnvironmentVariables launchd would export for the job. */
function plistEnvironment(plist: string): Record<string, string | undefined> {
  const block = plist
    .split("<key>EnvironmentVariables</key>", 2)[1]
    ?.split("</dict>", 1)[0];
  if (!block) return {};
  const entries = [
    ...block.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g),
  ];
  return Object.fromEntries(
    entries.map(([, key, value]) => [
      unescapeXml(key as string),
      unescapeXml(value as string),
    ]),
  );
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

test("an applied setup leaves a login service that is already serving the board", () => {
  const box = machine();

  const result = setupOperation(
    ["--target", `codex=${join(home, "codex")}`, "--yes"],
    {
      env: box.env,
      cwd: home,
      stdin: "",
      service: box.service,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(existsSync(box.plistPath)).toBe(true);
  expect(box.jobLoaded).toBe(true);
  // The job launchd started is answering, which is the whole point of
  // installing it: nobody has to run `eqnx serve` for the board to work.
  expect(box.connected).toBe(true);
});

/** What a browser does with a pairing link: exchange it for its own credential. */
async function pairBrowser(box: Machine, url: string): Promise<string> {
  const secret = new URLSearchParams(new URL(url).hash.slice(1)).get(
    "trace-pair",
  );
  const response = await box.fetch(
    `${CONNECTION_ENDPOINT_ORIGIN}/api/pairing`,
    {
      method: "POST",
      headers: { origin: HOSTED_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

/** A hosted-board read, exactly as the browser issues it. */
function hostedRead(box: Machine, token: string): Promise<Response> {
  return box.fetch(`${CONNECTION_ENDPOINT_ORIGIN}/api/tasks`, {
    headers: { origin: HOSTED_ORIGIN, authorization: `Bearer ${token}` },
  });
}

/** The pairing link `eqnx connection pair` printed. */
function printedLink(stdout: string): string {
  const link = stdout.match(
    new RegExp(`${HOSTED_ORIGIN}/#trace-pair=[A-Za-z0-9_-]+`),
  );
  expect(link).not.toBeNull();
  return link?.[0] as string;
}

test("a browser paired against the installed service reads the board", async () => {
  const box = machine();
  setupOperation(["--target", `codex=${join(home, "codex")}`, "--yes"], {
    env: box.env,
    cwd: home,
    stdin: "",
    service: box.service,
  });

  const paired = await connectionOperation(
    ["pair"],
    { env: box.env },
    box.dependencies,
  );
  expect(paired.exitCode).toBe(0);
  const token = await pairBrowser(box, printedLink(paired.stdout));

  expect((await hostedRead(box, token)).status).toBe(200);
  // Pairing is issuance, not a shared secret: an unpaired browser is refused.
  expect((await hostedRead(box, "not-a-paired-credential")).status).toBe(401);
});

test("a reboot brings the connection back with its browsers, but not its links", async () => {
  const box = machine();
  setupOperation(["--target", `codex=${join(home, "codex")}`, "--yes"], {
    env: box.env,
    cwd: home,
    stdin: "",
    service: box.service,
  });
  const paired = await connectionOperation(
    ["pair"],
    { env: box.env },
    box.dependencies,
  );
  const token = await pairBrowser(box, printedLink(paired.stdout));
  const unusedLink = printedLink(
    (await connectionOperation(["pair"], { env: box.env }, box.dependencies))
      .stdout,
  );

  const before = await connectionOperation(
    ["browsers"],
    { env: box.env },
    box.dependencies,
  );

  box.reboot();

  // Nobody logged in and ran anything: the login service is what brought the
  // board back.
  expect(box.connected).toBe(true);
  expect((await hostedRead(box, token)).status).toBe(200);
  const listed = await connectionOperation(
    ["browsers"],
    { env: box.env },
    box.dependencies,
  );
  expect(listed.stdout).toContain(before.stdout);

  // A link only ever lived in the process that minted it, so an unclaimed one
  // does not survive to be claimed later.
  const secret = new URLSearchParams(new URL(unusedLink).hash.slice(1)).get(
    "trace-pair",
  );
  const stale = await box.fetch(`${CONNECTION_ENDPOINT_ORIGIN}/api/pairing`, {
    method: "POST",
    headers: { origin: HOSTED_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  expect(stale.status).toBe(401);
});

/** The browser ids `eqnx connection browsers` printed, in listed order. */
async function browserIds(box: Machine): Promise<string[]> {
  const listed = await connectionOperation(
    ["browsers"],
    { env: box.env },
    box.dependencies,
  );
  expect(listed.exitCode).toBe(0);
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0] ?? "")
    .filter((id) => id.length > 0 && !id.includes(":"));
}

test("eqnx board lets a second browser in, and revoke shuts only that one out", async () => {
  const box = machine();
  setupOperation(["--target", `codex=${join(home, "codex")}`, "--yes"], {
    env: box.env,
    cwd: home,
    stdin: "",
    service: box.service,
  });
  const firstBrowser = await pairBrowser(
    box,
    printedLink(
      (await connectionOperation(["pair"], { env: box.env }, box.dependencies))
        .stdout,
    ),
  );
  const [firstBrowserId] = await browserIds(box);

  // A second browser on this machine: the same running connection hands out
  // the link, so nothing restarts and the first browser never drops.
  const opened: string[] = [];
  const board = await boardOperation(
    [],
    { env: box.env },
    { fetch: box.fetch, open: (url) => opened.push(url) },
  );
  expect(board.exitCode).toBe(0);
  const secondBrowser = await pairBrowser(box, opened[0] as string);

  expect((await hostedRead(box, firstBrowser)).status).toBe(200);
  expect((await hostedRead(box, secondBrowser)).status).toBe(200);
  const ids = await browserIds(box);
  expect(ids).toHaveLength(2);
  const secondBrowserId = ids.find((id) => id !== firstBrowserId) as string;

  const revoked = await connectionOperation(
    ["revoke", secondBrowserId],
    { env: box.env },
    box.dependencies,
  );
  expect(revoked.exitCode).toBe(0);

  // Immediately, against the same process — no restart, and the other browser
  // is untouched.
  expect((await hostedRead(box, secondBrowser)).status).toBe(401);
  expect((await hostedRead(box, firstBrowser)).status).toBe(200);
});

/** The runtime version the connection reports to a paired hosted board. */
async function handshakeVersion(box: Machine, token: string): Promise<string> {
  const response = await box.fetch(
    `${CONNECTION_ENDPOINT_ORIGIN}/api/connection`,
    { headers: { origin: HOSTED_ORIGIN, authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { runtimeVersion: string }).runtimeVersion;
}

test("an upgrade moves the running connection onto the new version, still paired", async () => {
  const box = machine();
  const context = {
    env: box.env,
    cwd: home,
    stdin: "",
    service: box.service,
  };
  setupOperation(
    ["--target", `codex=${join(home, "codex")}`, "--yes"],
    context,
  );
  const token = await pairBrowser(
    box,
    printedLink(
      (await connectionOperation(["pair"], { env: box.env }, box.dependencies))
        .stdout,
    ),
  );
  expect(await handshakeVersion(box, token)).toBe("1.0.0");

  const result = await updateOperation(
    ["--yes"],
    { env: box.env, cwd: home, stdin: "" },
    {
      fetchLatestVersion: async () => "2.0.0",
      spawnInstall: (_pm, version) => {
        // The package manager replaces the executable in place; the connection
        // launchd is holding keeps running the old one until something restarts it.
        box.installedVersion = version;
        return { status: 0, stderr: "" };
      },
      spawnReconcile: () =>
        setupOperation(["--registered", "--yes"], {
          ...context,
          env: box.env,
        }).exitCode === 0
          ? { status: 0, stderr: "" }
          : { status: 1, stderr: "reconcile failed" },
      restartConnection: (env) => restartConnectionService(env, box.service),
    },
  );

  expect(result.exitCode).toBe(0);
  // The whole point of the restart: a same-path upgrade otherwise leaves the
  // hosted board talking to the version it was talking to yesterday.
  expect(await handshakeVersion(box, token)).toBe("2.0.0");
  expect((await hostedRead(box, token)).status).toBe(200);
});

test("uninstall removes the connection and its browsers, and keeps the work", async () => {
  const box = machine();
  const codexTarget = join(home, "codex");
  setupOperation(["--target", `codex=${codexTarget}`, "--yes"], {
    env: box.env,
    cwd: home,
    stdin: "",
    service: box.service,
  });
  taskCreateOperation(["Ship the connection"], {
    env: box.env,
    cwd: home,
    stdin: "",
  });
  const token = await pairBrowser(
    box,
    printedLink(
      (await connectionOperation(["pair"], { env: box.env }, box.dependencies))
        .stdout,
    ),
  );
  expect((await hostedRead(box, token)).status).toBe(200);

  const removed = await connectionOperation(
    ["uninstall"],
    { env: box.env },
    box.dependencies,
  );

  expect(removed.exitCode).toBe(0);
  expect(existsSync(box.plistPath)).toBe(false);
  expect(box.jobLoaded).toBe(false);
  expect(box.connected).toBe(false);

  // The tasks and the agent integration are not the connection's to remove.
  expect(existsSync(codexTarget)).toBe(true);
  const tasks = taskListOperation([], { env: box.env, cwd: home, stdin: "" });
  expect(tasks.stdout).toContain("Ship the connection");

  // And the browser that was reading this machine cannot come back on the old
  // credential once the connection is reinstalled.
  await connectionOperation(["install"], { env: box.env }, box.dependencies);
  expect((await hostedRead(box, token)).status).toBe(401);
});

test("uninstalling twice is a no-op, not a failure", async () => {
  const box = machine();
  setupOperation(["--target", `codex=${join(home, "codex")}`, "--yes"], {
    env: box.env,
    cwd: home,
    stdin: "",
    service: box.service,
  });

  await connectionOperation(["uninstall"], { env: box.env }, box.dependencies);
  const again = await connectionOperation(
    ["uninstall"],
    { env: box.env },
    box.dependencies,
  );

  expect(again.exitCode).toBe(0);
});

test("with hosted access disabled, eqnx board reuses the connection it has", async () => {
  const box = machine({ hosted: false });
  setupOperation(["--target", `codex=${join(home, "codex")}`, "--yes"], {
    env: box.env,
    cwd: home,
    stdin: "",
    service: box.service,
  });

  // Nothing hosted was configured, so nothing hosted was baked into the job.
  expect(readFileSync(box.plistPath, "utf8")).toContain("<key>TRACE_WEB_ORIGIN</key>\n    <string></string>");

  const opened: string[] = [];
  const started: string[] = [];
  const board = await boardOperation(
    [],
    { env: box.env },
    {
      fetch: box.fetch,
      open: (url) => opened.push(url),
      start: async () => {
        started.push("foreground");
        throw new Error("the bundled board started a second runtime");
      },
    },
  );

  expect(board.exitCode).toBe(0);
  // The connection launchd is already running is the board; opening it is
  // never a reason to stand up a second runtime beside it.
  expect(opened).toEqual([`${CONNECTION_ENDPOINT_ORIGIN}/`]);
  expect(started).toEqual([]);

  // And it is recognisably *this* installation's, not a stranger on the port.
  const status = await connectionOperation(
    ["status"],
    { env: box.env },
    box.dependencies,
  );
  expect(status.stdout).toContain("Connection: running");
});

test("a waiting browser connects after terminal approval without opening another tab", async () => {
  const box = machine();
  await connectionOperation(["install"], { env: box.env }, box.dependencies);
  const post = (
    path: string,
    body?: unknown,
    origin: string | undefined = HOSTED_ORIGIN,
  ) =>
    box.fetch(`${CONNECTION_ENDPOINT_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        ...(origin ? { origin } : {}),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect(
    (await post("/api/pairing/requests", undefined, "https://evil.example"))
      .status,
  ).toBe(403);
  expect((await post("/api/pairing/requests", undefined, "")).status).toBe(403);
  const response = await post("/api/pairing/requests");
  expect(response.status).toBe(201);
  const request = (await response.json()) as { code: string; secret: string };
  expect(
    (await post("/api/pairing/requests/poll", { secret: request.code })).status,
  ).toBe(410);
  expect(
    (await post("/api/pairing/requests/poll", { secret: request.secret }))
      .status,
  ).toBe(202);
  expect(
    (await post(`/api/management/pairings/${request.code}/approve`)).status,
  ).toBe(403);
  const opened: string[] = [];
  const result = await connectionOperation(
    ["pair", request.code.toLowerCase()],
    { env: box.env },
    { ...box.dependencies, open: (url) => opened.push(url) },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Return to the page");
  expect(opened).toEqual([]);
  const claimed = await post("/api/pairing/requests/poll", {
    secret: request.secret,
  });
  expect(claimed.status).toBe(200);
  const { token } = (await claimed.json()) as { token: string };
  expect((await hostedRead(box, token)).status).toBe(200);
  expect(
    (await post("/api/pairing/requests/poll", { secret: request.secret }))
      .status,
  ).toBe(410);
  const next = (await (await post("/api/pairing/requests")).json()) as {
    code: string;
    secret: string;
  };
  await connectionOperation(
    ["pair", next.code],
    { env: box.env },
    box.dependencies,
  );
  await connectionOperation(["reset"], { env: box.env }, box.dependencies);
  expect(
    (await post("/api/pairing/requests/poll", { secret: next.secret })).status,
  ).toBe(410);
});
