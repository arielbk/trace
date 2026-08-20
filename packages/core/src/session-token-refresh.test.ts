import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openTraceStore } from "./index.ts";

function withTempStore(
  run: (store: ReturnType<typeof openTraceStore>, dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-token-refresh-"));
  try {
    const store = openTraceStore(join(dir, "trace.sqlite"));
    try {
      run(store, dir);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCodexTranscript(
  dir: string,
  id: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    total_tokens: number;
  },
): string {
  const transcriptPath = join(dir, `${id}.jsonl`);
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "thread.started",
        thread_id: id,
        model: "gpt-5-codex",
      }),
      JSON.stringify({
        type: "turn.completed",
        usage,
      }),
    ].join("\n"),
  );
  return transcriptPath;
}

test("refreshSessionTokens heals a pre-fix Codex row so buckets sum to the recorded total", () => {
  withTempStore((store, dir) => {
    const transcriptPath = writeCodexTranscript(dir, "stale-codex", {
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 80,
      total_tokens: 110,
    });

    const stored = store.registerSession({
      id: "stale-codex",
      transcriptPath,
      tool: "codex",
      tokenTotals: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 80,
        totalTokens: 110,
      },
    });

    const storedBucketSum =
      stored.tokenTotals.inputTokens +
      stored.tokenTotals.outputTokens +
      stored.tokenTotals.cacheCreationInputTokens +
      stored.tokenTotals.cacheReadInputTokens;
    expect(storedBucketSum).toBe(190);
    expect(stored.tokenTotals.totalTokens).toBe(110);

    expect(store.refreshSessionTokens()).toEqual({
      healed: 1,
      unchanged: 0,
      unhealable: 0,
    });

    const healed = store.getSession("stale-codex");
    expect(healed).not.toBeNull();
    expect(healed!.tokenTotals).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 80,
      totalTokens: 110,
    });
    expect(healed!.model).toBe("gpt-5-codex");
    expect(
      healed!.tokenTotals.inputTokens +
        healed!.tokenTotals.outputTokens +
        healed!.tokenTotals.cacheCreationInputTokens +
        healed!.tokenTotals.cacheReadInputTokens,
    ).toBe(healed!.tokenTotals.totalTokens);
  });
});

test("refreshSessionTokens leaves a missing-transcript row untouched and counts it unhealable", () => {
  withTempStore((store, dir) => {
    const missingPath = join(dir, "gone.jsonl");
    store.registerSession({
      id: "gone-codex",
      transcriptPath: missingPath,
      tool: "codex",
      model: "gpt-5-codex",
      tokenTotals: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 80,
        totalTokens: 110,
      },
    });

    expect(store.refreshSessionTokens()).toEqual({
      healed: 0,
      unchanged: 0,
      unhealable: 1,
    });

    const untouched = store.getSession("gone-codex");
    expect(untouched).not.toBeNull();
    expect(untouched!.tokenTotals).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 80,
      totalTokens: 110,
    });
    expect(untouched!.model).toBe("gpt-5-codex");
  });
});

test("refreshSessionTokens reports healed, unchanged, and unhealable counts and is idempotent", () => {
  withTempStore((store, dir) => {
    const stalePath = writeCodexTranscript(dir, "stale-codex", {
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 80,
      total_tokens: 110,
    });
    const currentPath = writeCodexTranscript(dir, "current-codex", {
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 80,
      total_tokens: 110,
    });

    store.registerSession({
      id: "stale-codex",
      transcriptPath: stalePath,
      tool: "codex",
      tokenTotals: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 80,
        totalTokens: 110,
      },
    });
    store.registerSession({
      id: "current-codex",
      transcriptPath: currentPath,
      tool: "codex",
      model: "gpt-5-codex",
      tokenTotals: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadInputTokens: 80,
        totalTokens: 110,
      },
    });
    store.registerSession({
      id: "gone-codex",
      transcriptPath: join(dir, "gone.jsonl"),
      tool: "codex",
      tokenTotals: {
        inputTokens: 50,
        outputTokens: 5,
        totalTokens: 55,
      },
    });

    expect(store.refreshSessionTokens()).toEqual({
      healed: 1,
      unchanged: 1,
      unhealable: 1,
    });
    expect(store.refreshSessionTokens()).toEqual({
      healed: 0,
      unchanged: 2,
      unhealable: 1,
    });
  });
});

test("refreshSessionTokens --tool only visits sessions for that tool", () => {
  withTempStore((store, dir) => {
    const codexPath = writeCodexTranscript(dir, "stale-codex", {
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 80,
      total_tokens: 110,
    });
    store.registerSession({
      id: "stale-codex",
      transcriptPath: codexPath,
      tool: "codex",
      tokenTotals: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 80,
        totalTokens: 110,
      },
    });
    store.registerSession({
      id: "gone-claude",
      transcriptPath: join(dir, "gone-claude.jsonl"),
      tool: "claude",
      tokenTotals: { inputTokens: 9, outputTokens: 1, totalTokens: 10 },
    });

    expect(store.refreshSessionTokens({ tool: "codex" })).toEqual({
      healed: 1,
      unchanged: 0,
      unhealable: 0,
    });
    expect(store.getSession("gone-claude")!.tokenTotals.inputTokens).toBe(9);
  });
});
