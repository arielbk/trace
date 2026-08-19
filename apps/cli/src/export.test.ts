import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openTraceStore,
  resolveTaskDocsDir,
  unzipExportBundle,
} from "@trace/core";
import { expect, test } from "vitest";
import { runTraceCli } from "./trace.ts";

function tempEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    TRACE_DB: join(dir, "trace.sqlite"),
    TRACE_CURRENT_VERSION: "0.19.0",
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.session_id;
  delete env.CODEX_THREAD_ID;
  delete env.CURSOR_CONVERSATION_ID;
  return env;
}

function unzipText(zipPath: string): {
  names: string[];
  text: (path: string) => string;
  folder: string;
} {
  const files = unzipExportBundle(new Uint8Array(readFileSync(zipPath)));
  const names = Object.keys(files).sort();
  const folder = names[0]?.split("/")[0] ?? "";
  return {
    names,
    folder,
    text: (path) => new TextDecoder().decode(files[path]),
  };
}

test("trace export writes a dated zip with README, manifest, and docs", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-export-"));
  const env = tempEnv(dir);
  const databasePath = env.TRACE_DB as string;

  try {
    mkdirSync(join(dir, ".git"));
    const created = runTraceCli(
      ["task", "create", "Checkout", "--description", "Ship the cart"],
      env,
      dir,
    );
    expect(created.exitCode).toBe(0);
    const slug = created.stdout.trim();
    expect(slug).toBe("checkout");

    const store = openTraceStore(databasePath);
    const task = store.getTaskByRef(slug)!;
    const docsDir = resolveTaskDocsDir(databasePath, task.slug);
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "state.md"), "# State\nWhere things stand.\n");
    writeFileSync(join(docsDir, "notes.md"), "native notes\n");
    const registeredPath = join(dir, "elsewhere", "notes.md");
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    writeFileSync(registeredPath, "registered notes\n");
    store.addTaskDoc(task.id, registeredPath, {
      title: "External notes",
      description: "From elsewhere",
    });

    store.assignSession(
      store.registerSession({
        id: "root-1",
        transcriptPath: join(dir, "root.jsonl"),
        tool: "claude",
        model: "claude-opus-4",
        title: "Wire the cart",
        tokenTotals: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 15,
        },
      }).id,
      task.id,
    );
    store.assignSession(
      store.registerSession({
        id: "sub-1",
        transcriptPath: join(dir, "sub.jsonl"),
        tool: "claude",
        model: "claude-sonnet-4",
        origin: "subagent",
        parentSessionId: "root-1",
        tokenTotals: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 4,
          cacheReadInputTokens: 8,
          totalTokens: 162,
        },
      }).id,
      task.id,
    );
    store.assignSession(
      store.registerSession({
        id: "spawn-1",
        transcriptPath: join(dir, "spawn.jsonl"),
        tool: "codex",
        model: "gpt-5",
        origin: "spawned",
        parentSessionId: "root-1",
        tokenTotals: {
          inputTokens: 3,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 1,
          totalTokens: 6,
        },
      }).id,
      task.id,
    );
    store.close();

    const result = runTraceCli(["export", "checkout"], env, dir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const date = new Date().toISOString().slice(0, 10);
    const zipPath = join(dir, `checkout-${date}.zip`);
    expect(result.stdout).toBe(`${zipPath}\n`);
    expect(existsSync(zipPath)).toBe(true);

    const zip = unzipText(zipPath);
    expect(zip.folder).toBe(`checkout-${date}`);
    expect(zip.names).toContain(`${zip.folder}/README.md`);
    expect(zip.names).toContain(`${zip.folder}/manifest.json`);
    expect(zip.names).toContain(`${zip.folder}/docs/state.md`);
    expect(zip.names.some((name) => name.startsWith(`${zip.folder}/transcripts/`))).toBe(
      false,
    );

    const nativeNotes = zip.names.find(
      (name) =>
        name.startsWith(`${zip.folder}/docs/`) &&
        zip.text(name) === "native notes\n",
    );
    const registeredNotes = zip.names.find(
      (name) =>
        name.startsWith(`${zip.folder}/docs/`) &&
        zip.text(name) === "registered notes\n",
    );
    expect(nativeNotes).toBeDefined();
    expect(registeredNotes).toBeDefined();
    expect(nativeNotes).not.toBe(registeredNotes);

    const manifest = JSON.parse(zip.text(`${zip.folder}/manifest.json`)) as {
      formatVersion: number;
      generator: string;
      task: { slug: string; title: string; description: string };
      project: { slug: string };
      docs: Array<{ path: string; source: string; sourcePath: string }>;
      sessions: Array<{ id: string; origin: string }>;
      totals: {
        rootSessions: number;
        subagentSessions: number;
        spawnedSessions: number;
        tokens: { input: number; output: number; total: number };
        firstSessionAt: string;
        lastSessionAt: string;
      };
    };

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.generator).toBe("0.19.0");
    expect(manifest.task.slug).toBe("checkout");
    expect(manifest.task.title).toBe("Checkout");
    expect(manifest.task.description).toBe("Ship the cart");
    expect(manifest.project.slug).toBeDefined();
    expect(manifest.sessions.map((session) => session.origin).sort()).toEqual([
      "root",
      "spawned",
      "subagent",
    ]);
    expect(manifest.totals.rootSessions).toBe(1);
    expect(manifest.totals.subagentSessions).toBe(1);
    expect(manifest.totals.spawnedSessions).toBe(1);
    expect(manifest.totals.tokens).toMatchObject({
      input: 113,
      output: 57,
      total: 183,
    });
    expect(manifest.totals.firstSessionAt).toEqual(expect.any(String));
    expect(manifest.totals.lastSessionAt).toEqual(expect.any(String));
    expect(JSON.stringify(manifest).toLowerCase()).not.toMatch(/duration/);
    expect(manifest.docs[0]?.path).toBe("docs/state.md");
    expect(manifest.docs.map((doc) => doc.source).sort()).toEqual([
      "native",
      "native",
      "registered",
    ]);
    expect(new Set(manifest.docs.map((doc) => doc.path)).size).toBe(3);

    const readme = zip.text(`${zip.folder}/README.md`);
    const manifestJson = JSON.stringify(manifest);
    expect(readme).not.toContain(registeredPath);
    for (const fact of [
      "Checkout",
      "Ship the cart",
      "checkout",
      task.id,
      "0.19.0",
      "root-1",
      "sub-1",
      "spawn-1",
      "docs/state.md",
      "External notes",
    ]) {
      expect(readme).toContain(fact);
      expect(manifestJson).toContain(fact);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace export with no task argument exports the bound task", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-export-bound-"));
  const env = tempEnv(dir);
  env.CLAUDE_CODE_SESSION_ID = "bound-session";

  try {
    mkdirSync(join(dir, ".git"));
    expect(runTraceCli(["task", "create", "Bound export"], env, dir).exitCode).toBe(
      0,
    );
    expect(
      runTraceCli(["skill", "work-on-task", "bound-export"], env, dir).exitCode,
    ).toBe(0);

    const result = runTraceCli(["export"], env, dir);
    expect(result.exitCode).toBe(0);
    const date = new Date().toISOString().slice(0, 10);
    const zipPath = join(dir, `bound-export-${date}.zip`);
    expect(result.stdout).toBe(`${zipPath}\n`);
    expect(existsSync(zipPath)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace export --out writes the zip to the given path", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-export-out-"));
  const env = tempEnv(dir);

  try {
    mkdirSync(join(dir, ".git"));
    expect(runTraceCli(["task", "create", "Checkout"], env, dir).exitCode).toBe(0);

    const outPath = join(dir, "nested", "custom.zip");
    const result = runTraceCli(["export", "checkout", "--out", outPath], env, dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${outPath}\n`);
    expect(existsSync(outPath)).toBe(true);

    const zip = unzipText(outPath);
    expect(zip.names).toContain(`${zip.folder}/manifest.json`);
    expect(JSON.parse(zip.text(`${zip.folder}/manifest.json`)).task.slug).toBe(
      "checkout",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
