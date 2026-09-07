import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
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

test("local and hosted builds keep independent output directories", async () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const isolatedRoot = await mkdtemp(
    path.join(tmpdir(), "trace-isolated-builds-"),
  );
  buildDirectories.push(isolatedRoot);

  await cp(
    path.join(projectRoot, "index.html"),
    path.join(isolatedRoot, "index.html"),
  );
  await symlink(path.join(projectRoot, "src"), path.join(isolatedRoot, "src"));

  const runBuild = (mode: "production" | "hosted") =>
    build({
      root: isolatedRoot,
      configFile: path.join(projectRoot, "vite.config.ts"),
      mode,
      logLevel: "silent",
    });

  await runBuild("production");
  const localBeforeHosted = await readBuildOutput(
    path.join(isolatedRoot, "dist"),
  );

  await runBuild("hosted");
  const localAfterHosted = await readBuildOutput(
    path.join(isolatedRoot, "dist"),
  );
  const hostedBeforeLocal = await readBuildOutput(
    path.join(isolatedRoot, "dist-hosted"),
  );

  expect(localAfterHosted).toEqual(localBeforeHosted);
  expect(localAfterHosted).not.toContain("Content-Security-Policy");
  expect(localAfterHosted).not.toContain("http://127.0.0.1:4317");
  expect(hostedBeforeLocal).toContain("Content-Security-Policy");
  expect(hostedBeforeLocal).toContain("http://127.0.0.1:4317");

  await runBuild("production");
  expect(await readBuildOutput(path.join(isolatedRoot, "dist-hosted"))).toEqual(
    hostedBeforeLocal,
  );
});

async function readBuildOutput(directory: string): Promise<string> {
  const entries = await readdir(directory, { recursive: true });
  const files = await Promise.all(
    entries.sort().map(async (entry) => {
      const filePath = path.join(directory, entry);
      try {
        return `${entry}\n${await readFile(filePath, "utf8")}`;
      } catch {
        return "";
      }
    }),
  );
  return files.join("\n");
}
