import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { buildExportBundle, type ExportBundleInput } from "./export-bundle.ts";
import { costFromTokenTotals, pricedAt, resolveRate } from "./pricing.ts";

const exportedAt = "2026-08-19T16:00:00.000Z";
const folder = "checkout-2026-08-19";

function input(overrides: Partial<ExportBundleInput> = {}): ExportBundleInput {
  return {
    exportedAt,
    generator: "0.19.0",
    task: {
      id: "task-1",
      slug: "checkout",
      title: "Checkout",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    project: { slug: "trace" },
    docs: [],
    sessions: [],
    ...overrides,
  };
}

function fileMap(files: ReturnType<typeof buildExportBundle>): Map<string, string> {
  return new Map(
    files.map((file) => [
      file.path,
      typeof file.contents === "string"
        ? file.contents
        : new TextDecoder().decode(file.contents),
    ]),
  );
}

function session(
  overrides: Partial<ExportBundleInput["sessions"][number]> & { id: string },
): ExportBundleInput["sessions"][number] {
  return {
    tool: "claude",
    model: "claude-opus-4",
    origin: "root",
    parentSessionId: null,
    subagentType: null,
    title: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T01:00:00.000Z",
    machineId: "machine-a",
    tokens: {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      totalTokens: 33,
    },
    ...overrides,
  };
}

test("buildExportBundle writes a single top-level folder with README, manifest, and docs", () => {
  const files = buildExportBundle(input());
  const paths = files.map((file) => file.path).sort();

  expect(paths.filter((path) => !path.startsWith(`${folder}/`))).toEqual([]);
  expect(paths).toContain(`${folder}/README.md`);
  expect(paths).toContain(`${folder}/manifest.json`);
  expect(paths.some((path) => path === `${folder}/docs/` || path.startsWith(`${folder}/docs/`))).toBe(
    true,
  );
  expect(new Set(paths.map((path) => path.split("/")[0]))).toEqual(new Set([folder]));
});

test("manifest.json carries formatVersion 1 and the documented top-level blocks", () => {
  const files = fileMap(
    buildExportBundle(
      input({
        task: {
          id: "task-1",
          slug: "checkout",
          title: "Checkout",
          description: "Ship the cart",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        project: { slug: "trace", remote: "github.com/arielbk/trace" },
      }),
    ),
  );
  const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!) as Record<
    string,
    unknown
  >;

  expect(manifest.formatVersion).toBe(1);
  expect(manifest.pricedAt).toBe(pricedAt);
  expect(manifest.generator).toBe("0.19.0");
  expect(manifest.exportedAt).toBe(exportedAt);
  expect(manifest.task).toEqual({
    id: "task-1",
    slug: "checkout",
    title: "Checkout",
    description: "Ship the cart",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  expect(manifest.project).toEqual({
    slug: "trace",
    remote: "github.com/arielbk/trace",
  });
  expect(manifest.docs).toEqual([]);
  expect(manifest.sessions).toEqual([]);
  expect(manifest.totals).toEqual({
    rootSessions: 0,
    subagentSessions: 0,
    spawnedSessions: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      total: 0,
    },
    freshTotal: 0,
    tools: [],
    models: [],
  });
});

test("totals.rootSessions excludes subagent and spawned sessions while token totals include them", () => {
  const files = fileMap(
    buildExportBundle(
      input({
        sessions: [
          session({
            id: "root-1",
            origin: "root",
            tokens: {
              inputTokens: 10,
              outputTokens: 5,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              totalTokens: 15,
            },
          }),
          session({
            id: "sub-1",
            origin: "subagent",
            parentSessionId: "root-1",
            tokens: {
              inputTokens: 100,
              outputTokens: 50,
              cacheCreationInputTokens: 4,
              cacheReadInputTokens: 8,
              totalTokens: 162,
            },
          }),
          session({
            id: "spawn-1",
            origin: "spawned",
            parentSessionId: "root-1",
            tokens: {
              inputTokens: 3,
              outputTokens: 2,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 1,
              totalTokens: 6,
            },
          }),
        ],
      }),
    ),
  );
  const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!) as {
    totals: {
      rootSessions: number;
      subagentSessions: number;
      spawnedSessions: number;
      tokens: Record<string, number>;
      freshTotal: number;
    };
    sessions: Array<{ origin: string }>;
  };

  expect(manifest.sessions.map((row) => row.origin)).toEqual([
    "root",
    "subagent",
    "spawned",
  ]);
  expect(manifest.totals.rootSessions).toBe(1);
  expect(manifest.totals.subagentSessions).toBe(1);
  expect(manifest.totals.spawnedSessions).toBe(1);
  expect(manifest.totals.tokens).toEqual({
    input: 113,
    output: 57,
    cacheCreation: 4,
    cacheRead: 9,
    total: 183,
  });
  expect(manifest.totals.freshTotal).toBe(170);
});

test("totals emit firstSessionAt and lastSessionAt and no duration field", () => {
  const files = fileMap(
    buildExportBundle(
      input({
        sessions: [
          session({ id: "later", createdAt: "2026-08-12T00:00:00.000Z" }),
          session({ id: "earlier", createdAt: "2026-08-09T00:00:00.000Z" }),
        ],
      }),
    ),
  );
  const raw = files.get(`${folder}/manifest.json`)!;
  const manifest = JSON.parse(raw) as {
    totals: Record<string, unknown>;
  };

  expect(manifest.totals.firstSessionAt).toBe("2026-08-09T00:00:00.000Z");
  expect(manifest.totals.lastSessionAt).toBe("2026-08-12T00:00:00.000Z");
  expect(raw.toLowerCase()).not.toMatch(/duration/);
  expect(Object.keys(manifest.totals)).not.toContain("duration");
});

test("state.md is ordered first in docs/", () => {
  const files = buildExportBundle(
    input({
      docs: [
        {
          sourcePath: "/docs/plan.md",
          contents: "# Plan\n",
          source: "native",
        },
        {
          sourcePath: "/docs/state.md",
          contents: "# State\n",
          source: "native",
        },
        {
          sourcePath: "/elsewhere/notes.md",
          contents: "notes",
          title: "Notes",
          source: "registered",
        },
      ],
    }),
  );
  const docFiles = files
    .map((file) => file.path)
    .filter((path) => path.startsWith(`${folder}/docs/`) && path !== `${folder}/docs/`);
  expect(docFiles[0]).toBe(`${folder}/docs/state.md`);

  const manifest = JSON.parse(
    fileMap(files).get(`${folder}/manifest.json`)!,
  ) as { docs: Array<{ path: string }> };
  expect(manifest.docs[0]?.path).toBe("docs/state.md");
});

test("a native doc and a registered doc sharing a basename keep distinct bundle paths", () => {
  const files = fileMap(
    buildExportBundle(
      input({
        docs: [
          {
            sourcePath: "/tasks/checkout/docs/notes.md",
            contents: "native notes",
            source: "native",
          },
          {
            sourcePath: "/tmp/notes.md",
            contents: "registered notes",
            title: "External notes",
            description: "From elsewhere",
            source: "registered",
          },
        ],
      }),
    ),
  );

  expect(files.get(`${folder}/docs/notes.md`)).toBe("native notes");
  expect(files.get(`${folder}/docs/notes-2.md`)).toBe("registered notes");

  const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!) as {
    docs: Array<{
      path: string;
      source: string;
      sourcePath: string;
      title?: string;
      description?: string;
    }>;
  };
  expect(manifest.docs).toEqual([
    {
      path: "docs/notes.md",
      source: "native",
      sourcePath: "/tasks/checkout/docs/notes.md",
    },
    {
      path: "docs/notes-2.md",
      title: "External notes",
      description: "From elsewhere",
      source: "registered",
      sourcePath: "/tmp/notes.md",
    },
  ]);
});

test("every fact README.md states also appears in manifest.json", () => {
  const files = fileMap(
    buildExportBundle(
      input({
        task: {
          id: "task-1",
          slug: "checkout",
          title: "Checkout",
          description: "Ship the cart",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        project: { slug: "trace", remote: "github.com/arielbk/trace" },
        sessions: [
          session({
            id: "root-1",
            title: "Wire the cart",
            createdAt: "2026-08-09T00:00:00.000Z",
          }),
          session({
            id: "sub-1",
            origin: "subagent",
            parentSessionId: "root-1",
            model: "claude-sonnet-4",
            createdAt: "2026-08-12T00:00:00.000Z",
          }),
        ],
        docs: [
          {
            sourcePath: "/docs/state.md",
            contents: "# State\n",
            source: "native",
          },
          {
            sourcePath: "/tmp/notes.md",
            contents: "notes",
            title: "External notes",
            source: "registered",
          },
        ],
      }),
    ),
  );
  const readme = files.get(`${folder}/README.md`)!;
  const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!);
  const manifestJson = JSON.stringify(manifest);

  expect(readme.length).toBeGreaterThan(0);
  expect(readme).not.toContain("/docs/state.md");
  expect(readme).not.toContain("/tmp/notes.md");

  const facts = [
    "Checkout",
    "Ship the cart",
    "task-1",
    "checkout",
    "2026-08-01T00:00:00.000Z",
    "trace",
    "github.com/arielbk/trace",
    "0.19.0",
    exportedAt,
    "root-1",
    "sub-1",
    "claude-opus-4",
    "claude-sonnet-4",
    "Wire the cart",
    "docs/state.md",
    "docs/notes.md",
    "External notes",
    "2026-08-09T00:00:00.000Z",
    "2026-08-12T00:00:00.000Z",
    pricedAt,
  ];
  for (const fact of facts) {
    expect(readme, `README missing fact: ${fact}`).toContain(fact);
    expect(manifestJson, `manifest missing fact: ${fact}`).toContain(fact);
  }
});

test("included transcripts land under transcripts/ and on the session row", () => {
  const bytes = new TextEncoder().encode("verbatim jsonl\n");
  const files = fileMap(
    buildExportBundle(
      input({
        sessions: [
          session({
            id: "root-1",
            transcript: {
              status: "included",
              bytes,
              format: "claude-jsonl",
              extension: ".jsonl",
            },
          }),
        ],
      }),
    ),
  );

  expect(files.get(`${folder}/transcripts/root-1.jsonl`)).toBe("verbatim jsonl\n");

  const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!) as {
    sessions: Array<{ id: string; transcript: Record<string, string> }>;
  };
  expect(manifest.sessions[0]?.transcript).toEqual({
    status: "included",
    format: "claude-jsonl",
    path: "transcripts/root-1.jsonl",
  });
});

test("unavailable transcript statuses are distinguished and write no file", () => {
  const files = buildExportBundle(
    input({
      sessions: [
        session({ id: "other", transcript: { status: "another-machine" } }),
        session({ id: "gone", transcript: { status: "file-gone" } }),
        session({ id: "synthetic", transcript: { status: "no-transcript-file" } }),
      ],
    }),
  );
  const paths = files.map((file) => file.path);
  expect(paths.some((path) => path.includes("/transcripts/"))).toBe(false);

  const manifest = JSON.parse(fileMap(files).get(`${folder}/manifest.json`)!) as {
    sessions: Array<{ id: string; transcript: { status: string } }>;
  };
  expect(manifest.sessions.map((row) => [row.id, row.transcript.status])).toEqual([
    ["other", "another-machine"],
    ["gone", "file-gone"],
    ["synthetic", "no-transcript-file"],
  ]);
});

test("sessions omit transcript when it was not requested", () => {
  const files = fileMap(
    buildExportBundle(input({ sessions: [session({ id: "root-1" })] })),
  );
  const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!) as {
    sessions: Array<{ transcript?: unknown }>;
  };
  expect(manifest.sessions[0]?.transcript).toBeUndefined();
  expect([...files.keys()].some((path) => path.includes("/transcripts/"))).toBe(false);
});

test("emitted manifest key set matches the checked-in schema fixture", () => {
  const files = fileMap(
    buildExportBundle(
      input({
        task: {
          id: "task-1",
          slug: "checkout",
          title: "Checkout",
          description: "Ship the cart",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        project: { slug: "trace", remote: "github.com/arielbk/trace" },
        docs: [
          {
            sourcePath: "/docs/state.md",
            contents: "# State\n",
            title: "State",
            description: "Where we left off",
            source: "native",
          },
        ],
        sessions: [
          session({
            id: "root-1",
            model: "claude-haiku-4-5",
            title: "Wire the cart",
            parentSessionId: null,
            subagentType: null,
            transcript: {
              status: "included",
              bytes: new TextEncoder().encode("verbatim\n"),
              format: "claude-jsonl",
              extension: ".jsonl",
            },
          }),
        ],
      }),
    ),
  );
  const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!);
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/export-manifest-keys.json", import.meta.url), "utf8"),
  );

  expect(manifestKeySet(manifest)).toEqual(fixture);
});

function manifestKeySet(value: unknown): unknown {
  if (Array.isArray(value)) {
    const sample = value.find(
      (item) => item !== null && typeof item === "object" && !Array.isArray(item),
    );
    return sample ? manifestKeySet(sample) : true;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, manifestKeySet((value as Record<string, unknown>)[key])]),
    );
  }
  return true;
}

test("priced sessions carry a cost object; unpriced sessions omit it", () => {
  const priced = session({
    id: "priced-1",
    model: "claude-haiku-4-5",
  });
  const unpriced = session({
    id: "unpriced-1",
    model: "not-a-real-model",
  });
  const files = fileMap(
    buildExportBundle(input({ sessions: [priced, unpriced] })),
  );
  const manifest = JSON.parse(files.get(`${folder}/manifest.json`)!) as {
    formatVersion: number;
    sessions: Array<{ id: string; cost?: { usd: number } }>;
  };

  expect(manifest.formatVersion).toBe(1);
  expect(manifest.sessions[0]?.cost).toEqual({
    usd: costFromTokenTotals(
      priced.tokens,
      resolveRate(priced.tool, priced.model)!,
    ),
  });
  expect(manifest.sessions[1]?.cost).toBeUndefined();
  expect(Object.keys(manifest.sessions[1] ?? {})).not.toContain("cost");
});

test("totals.cost carries amount and coverage counts, and is absent when nothing is priced", () => {
  const priced = session({
    id: "priced-1",
    model: "claude-haiku-4-5",
  });
  const unpriced = session({
    id: "unpriced-1",
    model: "not-a-real-model",
  });

  const mixed = JSON.parse(
    fileMap(buildExportBundle(input({ sessions: [priced, unpriced] }))).get(
      `${folder}/manifest.json`,
    )!,
  ) as {
    formatVersion: number;
    totals: {
      cost?: { usd: number; pricedSessions: number; unpricedSessions: number };
    };
  };
  expect(mixed.formatVersion).toBe(1);
  expect(mixed.totals.cost).toEqual({
    usd: costFromTokenTotals(
      priced.tokens,
      resolveRate(priced.tool, priced.model)!,
    ),
    pricedSessions: 1,
    unpricedSessions: 1,
  });

  const none = JSON.parse(
    fileMap(buildExportBundle(input({ sessions: [unpriced] }))).get(
      `${folder}/manifest.json`,
    )!,
  ) as { totals: { cost?: unknown } };
  expect(none.totals.cost).toBeUndefined();
  expect(Object.keys(none.totals)).not.toContain("cost");

  const empty = JSON.parse(
    fileMap(buildExportBundle(input())).get(`${folder}/manifest.json`)!,
  ) as { totals: { cost?: unknown } };
  expect(empty.totals.cost).toBeUndefined();
});
