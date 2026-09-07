import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { build } from "vite";

const buildDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    buildDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("hosted production build emits a strict CSP for the local Trace bridge", async () => {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "trace-hosted-build-"),
  );
  buildDirectories.push(outputDirectory);

  await build({
    root: path.resolve(import.meta.dirname, ".."),
    mode: "hosted",
    logLevel: "silent",
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
    },
  });

  const html = await readFile(path.join(outputDirectory, "index.html"), "utf8");
  const policyMatch = html.match(
    /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/,
  );
  const policy = policyMatch?.[1]?.replaceAll("&#39;", "'");
  const inlineScripts = [
    ...html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/g),
  ]
    .map((match) => match[1])
    .filter((script): script is string => Boolean(script?.trim()));
  const themeScriptHash = `sha256-${createHash("sha256")
    .update(inlineScripts[0] ?? "")
    .digest("base64")}`;

  expect(policy).toBe(
    "default-src 'none'; base-uri 'none'; form-action 'none'; " +
      `script-src 'self' '${themeScriptHash}'; ` +
      "style-src-elem 'self'; style-src-attr 'unsafe-inline'; " +
      "img-src 'self'; font-src 'self'; " +
      "connect-src 'self' http://127.0.0.1:4317",
  );
  expect(inlineScripts).toHaveLength(1);
  expect(html).not.toContain("fonts.googleapis.com");
  expect(html).not.toContain("fonts.gstatic.com");
});
