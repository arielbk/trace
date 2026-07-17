import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openTraceStore, resolveProjectRoot } from "@trace/core";
import { expect, test } from "vitest";

const traceBin = fileURLToPath(new URL("./trace.ts", import.meta.url));
// The project slug the CLI declares derives from this checkout's directory
// name, which differs across clones and worktrees.
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const projectSlug = basename(repoRoot).toLowerCase();

test("init reports plugin setup without writing Claude settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-init-"));
  const env = {
    ...process.env,
    HOME: dir,
    TRACE_DB: join(dir, "trace.sqlite"),
  };

  try {
    const output = execFileSync(process.execPath, [traceBin, "init"], {
      encoding: "utf8",
      env,
    });

    expect(output).toContain(
      "trace is now installed through the Claude Code plugin",
    );
    expect(output).toContain("/plugin marketplace add arielbk/trace");
    expect(output).toContain("/plugin install trace@trace");
    expect(output).toContain("trace skill: found");
    expect(output).not.toContain("pnpm link --global");
    expect(output).not.toContain("SessionStart hook");
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init preserves existing Claude settings without adding SessionStart hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-init-"));
  const settingsPath = join(dir, ".claude", "settings.json");
  const env = {
    ...process.env,
    HOME: dir,
    TRACE_DB: join(dir, "trace.sqlite"),
  };

  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Bash(git status:*)"] },
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
          },
        },
        null,
        2,
      ),
    );

    execFileSync(process.execPath, [traceBin, "init"], {
      encoding: "utf8",
      env,
    });
    const secondOutput = execFileSync(process.execPath, [traceBin, "init"], {
      encoding: "utf8",
      env,
    });

    expect(secondOutput).toContain(
      "trace is now installed through the Claude Code plugin",
    );

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions?: { allow?: string[] };
      hooks?: Record<
        string,
        Array<{ hooks?: Array<{ type?: string; command?: string }> }>
      >;
    };
    expect(settings.permissions?.allow).toEqual(["Bash(git status:*)"]);
    expect(settings.hooks?.Stop).toEqual([
      { hooks: [{ type: "command", command: "echo stop" }] },
    ]);
    expect(settings.hooks?.SessionStart).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create then show round-trips a persisted task", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    expect(slug).toBe("checkout");

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", slug],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(/slug: checkout/);
    expect(shown).toMatch(/id: [0-9a-f-]{36}/);
    expect(shown).toMatch(/title: checkout/);

    const listed = execFileSync(process.execPath, [traceBin, "task", "list"], {
      encoding: "utf8",
      env,
    });
    expect(listed).toBe(`${slug}\tcheckout\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task create --description persists the description", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [
        traceBin,
        "task",
        "create",
        "Checkout flow",
        "--description",
        "Rework the checkout into a multi-step wizard",
      ],
      { encoding: "utf8", env },
    ).trim();

    expect(slug).toBe("checkout-flow");

    const store = openTraceStore(databasePath);
    const task = store.getTaskByRef(slug);
    store.close();

    expect(task?.title).toBe("Checkout flow");
    expect(task?.description).toBe(
      "Rework the checkout into a multi-step wizard",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task update --description sets the description by id and by slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-update-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "Checkout flow"],
      { encoding: "utf8", env },
    ).trim();

    const store = openTraceStore(databasePath);
    const id = store.getTaskByRef(slug)?.id as string;
    store.close();

    const bySlug = execFileSync(
      process.execPath,
      [traceBin, "task", "update", slug, "--description", "First pass"],
      { encoding: "utf8", env },
    );
    expect(bySlug).toMatch(/slug: checkout-flow/);
    expect(bySlug).toMatch(/description: First pass/);

    const byId = execFileSync(
      process.execPath,
      [traceBin, "task", "update", id, "--description", "Second pass"],
      { encoding: "utf8", env },
    );
    expect(byId).toMatch(/description: Second pass/);

    const verifyStore = openTraceStore(databasePath);
    expect(verifyStore.getTaskByRef(slug)?.description).toBe("Second pass");
    verifyStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task update --title renames a task, keeps the slug, and combines with --description", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-rename-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "Checkout flow"],
      { encoding: "utf8", env },
    ).trim();

    const renamed = execFileSync(
      process.execPath,
      [traceBin, "task", "update", slug, "--title", "Cart wizard"],
      { encoding: "utf8", env },
    );
    expect(renamed).toMatch(/title: Cart wizard/);
    expect(renamed).toMatch(/slug: checkout-flow/);

    // A slug-shaped title humanizes, exactly as it would at create time.
    const humanized = execFileSync(
      process.execPath,
      [traceBin, "task", "update", slug, "--title", "cart-wizard-flow"],
      { encoding: "utf8", env },
    );
    expect(humanized).toMatch(/title: Cart wizard flow/);
    expect(humanized).toMatch(/slug: checkout-flow/);

    const combined = execFileSync(
      process.execPath,
      [
        traceBin,
        "task",
        "update",
        slug,
        "--title",
        "Cart wizard",
        "--description",
        "Second pass",
      ],
      { encoding: "utf8", env },
    );
    expect(combined).toMatch(/title: Cart wizard/);
    expect(combined).toMatch(/description: Second pass/);

    const store = openTraceStore(databasePath);
    const task = store.getTaskByRef(slug);
    store.close();

    expect(task?.title).toBe("Cart wizard");
    expect(task?.slug).toBe("checkout-flow");
    expect(task?.description).toBe("Second pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task update on an unknown ref exits non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-update-missing-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    let error: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(
        process.execPath,
        [traceBin, "task", "update", "missing", "--description", "text"],
        { encoding: "utf8", env },
      );
    } catch (caught) {
      error = caught as { status?: number; stderr?: string };
    }

    expect(error).toBeDefined();
    expect(error?.status).not.toBe(0);
    expect(error?.stderr).toContain("Task not found: missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task --description sets the description on create", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-desc-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "Checkout flow",
        "--id",
        "codex-session-1",
        "--transcript",
        "/tmp/codex-session-1.jsonl",
        "--tool",
        "codex",
        "--description",
        "Rework the checkout into a multi-step wizard",
      ],
      { encoding: "utf8", env },
    );

    const store = openTraceStore(databasePath);
    const task = store.getTaskByRef("checkout-flow");
    store.close();

    expect(task?.description).toBe(
      "Rework the checkout into a multi-step wizard",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill recall-candidates prints the project's unarchived tasks as JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-recall-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };
  // The child resolves its project root from process.cwd(), which on macOS
  // canonicalises symlinks (/var/folders → /private/var/folders); match it.
  const projectRoot = resolveProjectRoot(realpathSync(dir));

  try {
    const store = openTraceStore(databasePath);
    const described = store.createTask(
      "Checkout flow",
      projectRoot,
      "Rework the checkout into a wizard",
    );
    const bare = store.createTask("Loose end", projectRoot);
    store.createTask("Elsewhere", "/some/other/project", "off topic");
    const archived = store.createTask("Old work", projectRoot, "shipped");
    store.archiveTask(archived.id);
    store.close();

    const output = execFileSync(
      process.execPath,
      [traceBin, "skill", "recall-candidates"],
      { encoding: "utf8", env, cwd: dir },
    );

    const candidates = (
      JSON.parse(output) as Array<{
        title: string;
        slug: string;
        description?: string;
      }>
    ).sort((a, b) => a.title.localeCompare(b.title));

    expect(candidates).toEqual([
      {
        title: "Checkout flow",
        slug: described.slug,
        description: "Rework the checkout into a wizard",
      },
      { title: "Loose end", slug: bare.slug },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("register then assign session attaches it to task show", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "session-1",
        "--transcript",
        "/tmp/session-1.jsonl",
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );

    const unassigned = execFileSync(
      process.execPath,
      [traceBin, "session", "list", "--unassigned"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(unassigned).toBe("session-1\tcodex\t/tmp/session-1.jsonl\n");

    execFileSync(
      process.execPath,
      [traceBin, "session", "assign", "session-1", taskId],
      {
        encoding: "utf8",
        env,
      },
    );

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(/sessions:/);
    expect(shown).toMatch(/- session-1\tcodex\t\/tmp\/session-1\.jsonl/);

    const nowUnassigned = execFileSync(
      process.execPath,
      [traceBin, "session", "list", "--unassigned"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(nowUnassigned).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session tail prints recent transcript messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-tail-"));
  const databasePath = join(dir, "trace.sqlite");
  const transcriptPath = join(dir, "session-1.jsonl");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user_message", message: "First" }),
        JSON.stringify({ type: "assistant_message", message: "Second" }),
        JSON.stringify({ type: "user_message", message: "Third" }),
      ].join("\n"),
    );

    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "session-1",
        "--transcript",
        transcriptPath,
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );

    const tail = execFileSync(
      process.execPath,
      [traceBin, "session", "tail", "session-1", "--limit", "2"],
      { encoding: "utf8", env },
    );

    expect(tail).toBe("assistant: Second\nuser: Third\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add-doc then show lists the associated task doc", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    const added = execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", taskId, "/tmp/spec.md"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(added).toBe(`${taskId}\t/tmp/spec.md\n`);

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(/docs:/);
    expect(shown).toMatch(/- \/tmp\/spec\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add-doc with a relative path lists the doc once alongside the filesystem scan", () => {
  // realpath so the cwd handed to the CLI matches the spelling the
  // filesystem scan derives from TRACE_DB (macOS tmpdir is a symlink).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "trace-cli-")));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const docsDir = join(dir, "tasks", slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "spec.md"), "# Spec\n");

    // Registering by relative filename from inside the docs dir must not
    // produce a second entry next to the one the filesystem scan finds.
    const added = execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", slug, "spec.md"],
      { encoding: "utf8", env, cwd: docsDir },
    );
    expect(added).toBe(`${slug}\t${join(docsDir, "spec.md")}\n`);

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", slug],
      { encoding: "utf8", env },
    );
    expect(shown.match(/spec\.md/g)).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("show dedupes a legacy relative doc row against the filesystem scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const docsDir = join(dir, "tasks", slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "spec.md"), "# Spec\n");

    // Rows written before the CLI canonicalized paths carry the bare
    // filename; go through the store directly to simulate one.
    const store = openTraceStore(databasePath);
    store.addTaskDoc(slug, "spec.md");
    store.close();

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", slug],
      { encoding: "utf8", env },
    );
    expect(shown.match(/spec\.md/g)).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add-doc --description renders a fenced manifest footer into a created state.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const docsDir = join(dir, "tasks", slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    const docPath = join(docsDir, "spec.md");
    writeFileSync(docPath, "# Spec\n");

    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", slug, docPath, "--description", "The spec"],
      { encoding: "utf8", env },
    );

    const statePath = join(docsDir, "state.md");
    expect(existsSync(statePath)).toBe(true);
    const state = readFileSync(statePath, "utf8");
    expect(state).toContain("<!-- trace:docs-manifest:start -->");
    // The doc has no explicit title; its `# Spec` H1 resolves as the label.
    expect(state).toContain("- [Spec](spec.md) — The spec");
    expect(state).toContain("<!-- trace:docs-manifest:end -->");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add-doc --title renders the explicit title and description in the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const docsDir = join(dir, "tasks", slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    const docPath = join(docsDir, "spec.md");
    writeFileSync(docPath, "# Heading ignored\n");

    execFileSync(
      process.execPath,
      [
        traceBin,
        "task",
        "add-doc",
        slug,
        docPath,
        "--title",
        "Checkout Spec",
        "--description",
        "The spec",
      ],
      { encoding: "utf8", env },
    );

    const state = readFileSync(join(docsDir, "state.md"), "utf8");
    // Explicit title wins over the H1; description trails after the em dash.
    expect(state).toContain("- [Checkout Spec](spec.md) — The spec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add-doc with no title, H1, or description falls back to the filename and a clean line", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const docsDir = join(dir, "tasks", slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    const docPath = join(docsDir, "notes.md");
    // No explicit title, no ATX H1 (only a `## ` subheading) — basename floor.
    writeFileSync(docPath, "## Subheading only\n\nbody\n");

    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", slug, docPath],
      { encoding: "utf8", env },
    );

    const state = readFileSync(join(docsDir, "state.md"), "utf8");
    // Filename label, and no trailing " — " because there's no description.
    expect(state).toContain("- [notes.md](notes.md)\n");
    expect(state).not.toContain("- [notes.md](notes.md) —");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add-doc --title --description round-trips both onto the task doc", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    execFileSync(
      process.execPath,
      [
        traceBin,
        "task",
        "add-doc",
        slug,
        "/tmp/spec.md",
        "--title",
        "Checkout Spec",
        "--description",
        "The spec",
      ],
      { encoding: "utf8", env },
    );

    const timeline = JSON.parse(
      execFileSync(
        process.execPath,
        [traceBin, "task", "timeline", slug, "--json"],
        { encoding: "utf8", env },
      ),
    );
    const doc = timeline.items.find(
      (item: { type: string }) => item.type === "doc",
    )?.doc;
    expect(doc.title).toBe("Checkout Spec");
    expect(doc.description).toBe("The spec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update-doc rewrites an existing doc's title and description in the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const docsDir = join(dir, "tasks", slug, "docs");
    mkdirSync(docsDir, { recursive: true });
    const docPath = join(docsDir, "spec.md");
    writeFileSync(docPath, "# Heading ignored\n");

    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", slug, docPath, "--title", "Old", "--description", "Old desc"],
      { encoding: "utf8", env },
    );

    execFileSync(
      process.execPath,
      [traceBin, "task", "update-doc", slug, docPath, "--title", "New Title", "--description", "New desc"],
      { encoding: "utf8", env },
    );

    const state = readFileSync(join(docsDir, "state.md"), "utf8");
    expect(state).toContain("- [New Title](spec.md) — New desc");
    expect(state).not.toContain("Old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task show and skill re-enter list docs written under the trace task docs directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();
    const docsDir = join(dir, ".trace", "tasks", taskId, "docs");
    const docPath = join(docsDir, "decision.md");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(docPath, "# Decision\n");

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(/docs:/);
    expect(shown).toContain(`- ${docPath}`);

    const context = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(context).toMatch(/docs:/);
    expect(context).toContain(`- path: ${docPath}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task timeline --json prints the aggregated task timeline", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "session-1",
        "--transcript",
        "/tmp/session-1.jsonl",
        "--tool",
        "codex",
        "--model",
        "gpt-5-codex",
        "--input-tokens",
        "12",
        "--output-tokens",
        "8",
        "--total-tokens",
        "20",
      ],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [traceBin, "session", "assign", "session-1", taskId],
      {
        encoding: "utf8",
        env,
      },
    );
    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", taskId, "/tmp/spec.md"],
      {
        encoding: "utf8",
        env,
      },
    );

    const timeline = JSON.parse(
      execFileSync(
        process.execPath,
        [traceBin, "task", "timeline", taskId, "--json"],
        {
          encoding: "utf8",
          env,
        },
      ),
    ) as {
      task: { id: string; slug: string; title: string };
      items: Array<{
        type: string;
        session?: { id: string; model: string | null };
        doc?: { path: string };
      }>;
      tokenTotals: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    };

    expect(timeline.task.slug).toBe(taskId);
    expect(timeline.task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(timeline.task.title).toBe("checkout");
    // The session precedes the docs chronologically. add-doc also renders the
    // manifest into a freshly-created state.md, so it appears alongside the
    // registered doc (order between the two same-instant docs is incidental).
    expect(timeline.items[0]?.type).toBe("session");
    expect(timeline.items[0]?.session?.id).toBe("session-1");
    const docPaths = timeline.items
      .filter((item) => item.type === "doc")
      .map((item) => item.doc?.path);
    expect(docPaths).toContain("/tmp/spec.md");
    expect(docPaths.some((path) => path?.endsWith("state.md"))).toBe(true);
    expect(timeline.items[0]?.session?.model).toBe("gpt-5-codex");
    expect(timeline.tokenTotals).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 20,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task binds a simulated session and re-enter lists task context", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", slug, "/tmp/spec.md"],
      {
        encoding: "utf8",
        env,
      },
    );

    const bound = execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "checkout",
        "--id",
        "codex-session-1",
        "--transcript",
        "/tmp/codex-session-1.jsonl",
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );
    expect(bound).toBe(
      [
        `linked to existing project ${projectSlug}`,
        `codex-session-1\tcodex\t/tmp/codex-session-1.jsonl`,
        `taskDocsDir: ${join(dir, "tasks", slug, "docs")}`,
        "",
      ].join("\n"),
    );

    const shown = execFileSync(
      process.execPath,
      [traceBin, "task", "show", slug],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(shown).toMatch(
      /- codex-session-1\tcodex\t\/tmp\/codex-session-1\.jsonl/,
    );

    const context = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(context).toMatch(/task:\n {2}id: [0-9a-f-]{36}/);
    expect(context).toMatch(/docs:\n- path: \/tmp\/spec\.md/);
    expect(context).toMatch(
      /sessions:\n- id: codex-session-1\n {2}tool: codex\n {2}transcript: \/tmp\/codex-session-1\.jsonl\n {2}mostRecent: true/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task resurrects an archived task by exact title", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-unarchive-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();
    const setupStore = openTraceStore(databasePath);
    const archived = setupStore.archiveTask(slug);
    setupStore.close();

    expect(archived.archivedAt).not.toBeNull();

    execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "checkout",
        "--id",
        "codex-session-1",
        "--transcript",
        "/tmp/codex-session-1.jsonl",
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );

    const verifyStore = openTraceStore(databasePath);
    const tasks = verifyStore.listTaskSummaries();
    verifyStore.close();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: archived.id,
      title: "checkout",
      archivedAt: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill re-enter leaves archived tasks archived", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-reenter-archive-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const slug = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    ).trim();
    const setupStore = openTraceStore(databasePath);
    const archived = setupStore.archiveTask(slug);
    setupStore.close();

    execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      {
        encoding: "utf8",
        env,
      },
    );

    const verifyStore = openTraceStore(databasePath);
    const task = verifyStore.getTask(archived.id);
    verifyStore.close();

    expect(task?.archivedAt).toBe(archived.archivedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task infers the live Claude session from CLAUDE_CODE_SESSION_ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-infer-"));
  const databasePath = join(dir, "trace.sqlite");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRACE_DB: databasePath,
    CLAUDE_CODE_SESSION_ID: "live-claude-session",
  };
  // Prove CLAUDE_CODE_SESSION_ID is what's read, not the legacy names.
  delete env.CLAUDE_SESSION_ID;
  delete env.session_id;
  delete env.CODEX_THREAD_ID;

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const bound = execFileSync(
      process.execPath,
      [traceBin, "skill", "work-on-task", "checkout"],
      { encoding: "utf8", env },
    );
    expect(bound).toBe(
      [
        `linked to existing project ${projectSlug}`,
        `live-claude-session\tclaude\tclaude:live-claude-session`,
        `taskDocsDir: ${join(dir, "tasks", taskId, "docs")}`,
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task with a blank session id fails without creating the task", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-blank-"));
  const databasePath = join(dir, "trace.sqlite");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRACE_DB: databasePath,
    // The observed failure mode: a hook exports the var with a blank value, so
    // the id is defined-but-unusable. Create-or-bind must reject it before any
    // store mutation — a failed bind must not leave an orphan task behind.
    CLAUDE_CODE_SESSION_ID: "   ",
  };
  delete env.CLAUDE_SESSION_ID;
  delete env.session_id;
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDE_TRANSCRIPT_PATH;

  try {
    let failed: { status: number | null; stderr: string } | null = null;
    try {
      execFileSync(
        process.execPath,
        [traceBin, "skill", "work-on-task", "checkout"],
        { encoding: "utf8", env },
      );
    } catch (error) {
      const e = error as { status: number | null; stderr: string };
      failed = { status: e.status, stderr: e.stderr };
    }

    expect(failed?.status).toBe(2);
    expect(failed?.stderr).toContain(
      "requires --id or a current session env var",
    );

    const store = openTraceStore(databasePath);
    const tasks = store.listTasks();
    store.close();
    expect(tasks).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill re-enter prints an ordered manifest with empty sections", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-manifest-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    const emptyManifest = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      { encoding: "utf8", env },
    );
    expect(emptyManifest).toMatch(/task:\n {2}id: [0-9a-f-]{36}\n/);
    expect(emptyManifest).toContain("docs: []\n");
    expect(emptyManifest).toContain("sessions: []\n");

    const docsDir = join(dir, ".trace", "tasks", taskId, "docs");
    const nativeDocPath = join(docsDir, "decision.md");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(nativeDocPath, "# Decision\n");
    execFileSync(
      process.execPath,
      [traceBin, "task", "add-doc", taskId, "/tmp/external.md"],
      { encoding: "utf8", env },
    );

    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "older-session",
        "--transcript",
        "/tmp/older.jsonl",
        "--tool",
        "claude",
      ],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [traceBin, "session", "assign", "older-session", taskId],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [
        traceBin,
        "session",
        "register",
        "--id",
        "newer-session",
        "--transcript",
        "/tmp/newer.jsonl",
        "--tool",
        "codex",
      ],
      { encoding: "utf8", env },
    );
    execFileSync(
      process.execPath,
      [traceBin, "session", "assign", "newer-session", taskId],
      { encoding: "utf8", env },
    );

    const manifest = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "checkout"],
      { encoding: "utf8", env },
    );

    expect(manifest).toContain(`- path: ${nativeDocPath}`);
    expect(manifest).toContain("- path: /tmp/external.md");
    expect(manifest.indexOf("- id: newer-session")).toBeLessThan(
      manifest.indexOf("- id: older-session"),
    );
    expect(manifest).toMatch(
      /- id: newer-session\n {2}tool: codex\n {2}transcript: \/tmp\/newer\.jsonl\n {2}mostRecent: true/,
    );
    expect(manifest).toMatch(
      /- id: older-session\n {2}tool: claude\n {2}transcript: \/tmp\/older\.jsonl\n {2}mostRecent: false/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill re-enter surfaces the task description in the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-desc-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    execFileSync(
      process.execPath,
      [
        traceBin,
        "task",
        "create",
        "archive",
        "--description",
        "Move finished tasks out of the active board",
      ],
      { encoding: "utf8", env },
    );

    const describedManifest = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "archive"],
      { encoding: "utf8", env },
    );
    expect(describedManifest).toMatch(
      /title: archive\n {2}description: Move finished tasks out of the active board\n {2}projectRoot:/,
    );

    execFileSync(process.execPath, [traceBin, "task", "create", "plain"], {
      encoding: "utf8",
      env,
    });
    const plainManifest = execFileSync(
      process.execPath,
      [traceBin, "skill", "re-enter", "plain"],
      { encoding: "utf8", env },
    );
    expect(plainManifest).not.toContain("description:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill work-on-task --model persists the session model", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-skill-model-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "checkout"],
      { encoding: "utf8", env },
    ).trim();

    execFileSync(
      process.execPath,
      [
        traceBin,
        "skill",
        "work-on-task",
        "checkout",
        "--id",
        "claude-session-1",
        "--transcript",
        "/tmp/claude-session-1.jsonl",
        "--tool",
        "claude",
        "--model",
        "claude-opus-4-7",
      ],
      { encoding: "utf8", env },
    );

    const timeline = JSON.parse(
      execFileSync(
        process.execPath,
        [traceBin, "task", "timeline", taskId, "--json"],
        { encoding: "utf8", env },
      ),
    ) as {
      items: Array<{
        type: string;
        session?: { id: string; model: string | null };
      }>;
    };

    expect(timeline.items[0]?.session?.model).toBe("claude-opus-4-7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task create rejects a flag-looking title without creating a task", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    let error: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, [traceBin, "task", "create", "--oops"], {
        encoding: "utf8",
        env,
      });
    } catch (caught) {
      error = caught as { status?: number; stderr?: string };
    }

    expect(error).toBeDefined();
    expect(error?.status).not.toBe(0);
    expect(error?.stderr).toContain("Usage:");

    const listed = execFileSync(process.execPath, [traceBin, "task", "list"], {
      encoding: "utf8",
      env,
    });
    expect(listed).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task create --help prints usage without creating a task", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const output = execFileSync(
      process.execPath,
      [traceBin, "task", "create", "--help"],
      { encoding: "utf8", env },
    );
    expect(output).toContain("Usage:");

    const listed = execFileSync(process.execPath, [traceBin, "task", "list"], {
      encoding: "utf8",
      env,
    });
    expect(listed).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task capture --doc creates a task with one doc and zero token totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");
  const findingsPath = join(dir, "findings.md");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    writeFileSync(findingsPath, "# Findings\n\nFlaky test in checkout.\n");

    const taskId = execFileSync(
      process.execPath,
      [
        traceBin,
        "task",
        "capture",
        "Fix flaky checkout test",
        "--doc",
        findingsPath,
      ],
      { encoding: "utf8", env },
    ).trim();
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    // Captured docs live in the slug directory — the same place the
    // filesystem scan reads — not the legacy UUID directory.
    const copiedPath = join(
      dir,
      ".trace",
      "tasks",
      "fix-flaky-checkout-test",
      "docs",
      "findings.md",
    );
    expect(existsSync(copiedPath)).toBe(true);
    expect(readFileSync(copiedPath, "utf8")).toContain(
      "Flaky test in checkout",
    );

    const timeline = JSON.parse(
      execFileSync(
        process.execPath,
        [traceBin, "task", "timeline", taskId, "--json"],
        { encoding: "utf8", env },
      ),
    ) as {
      task: { title: string };
      items: Array<{ type: string; doc?: { path: string } }>;
      tokenTotals: { totalTokens: number };
    };

    expect(timeline.task.title).toBe("Fix flaky checkout test");
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]?.type).toBe("doc");
    expect(timeline.items[0]?.doc?.path).toBe(copiedPath);
    expect(timeline.tokenTotals.totalTokens).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task capture rejects a flag-looking title", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, "trace.sqlite");
  const findingsPath = join(dir, "findings.md");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    writeFileSync(findingsPath, "# Findings\n");

    let error: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(
        process.execPath,
        [traceBin, "task", "capture", "--help", "--doc", findingsPath],
        { encoding: "utf8", env },
      );
    } catch (caught) {
      error = caught as { status?: number; stderr?: string };
    }

    // --help is a help flag, so it prints usage with a success exit; either way
    // no task should be created.
    const listed = execFileSync(process.execPath, [traceBin, "task", "list"], {
      encoding: "utf8",
      env,
    });
    expect(listed).toBe("");
    expect(error?.status === undefined || error.status !== 0).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task capture reads doc content from stdin when no --doc is given", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    const taskId = execFileSync(
      process.execPath,
      [traceBin, "task", "capture", "Park follow-up idea"],
      { encoding: "utf8", env, input: "## Idea\n\nExtract the parser.\n" },
    ).trim();
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    const docPath = join(
      dir,
      ".trace",
      "tasks",
      "park-follow-up-idea",
      "docs",
      "capture.md",
    );
    expect(existsSync(docPath)).toBe(true);
    expect(readFileSync(docPath, "utf8")).toContain("Extract the parser.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task capture --link creates an idempotent repo docs symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-"));
  const databasePath = join(dir, ".trace", "trace.sqlite");
  const repoRoot = join(dir, "repo");
  const findingsPath = join(repoRoot, "findings.md");
  const env = { ...process.env, TRACE_DB: databasePath };

  try {
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    writeFileSync(findingsPath, "# Findings\n");

    const run = () =>
      execFileSync(
        process.execPath,
        [
          traceBin,
          "task",
          "capture",
          "Refactor parser",
          "--doc",
          findingsPath,
          "--link",
        ],
        { encoding: "utf8", env, cwd: repoRoot },
      ).trim();

    run();
    const linkPath = join(repoRoot, "docs", "refactor-parser");
    const target = join(dir, ".trace", "tasks", "refactor-parser", "docs");

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkPath)).toBe(realpathSync(target));

    // Re-running must not throw and must leave a single symlink (re-pointed at
    // the latest capture's docs dir, not a nested or duplicated link). The
    // second capture of the same title allocates a suffixed slug.
    run();
    const secondTarget = join(dir, ".trace", "tasks", "refactor-parser-2", "docs");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkPath)).toBe(realpathSync(secondTarget));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
