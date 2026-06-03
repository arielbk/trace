import { stripTypeScriptTypes } from "node:module";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const distDir = resolve(here, "../dist");
const pluginBinDir = resolve(repoRoot, "bin");
const coreEntry = resolve(repoRoot, "packages/core/src/index.ts");
const moduleSpecifierPattern =
  /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

type CollectedModule = {
  id: string;
  path: string;
  source: string;
};

mkdirSync(distDir, { recursive: true });
mkdirSync(pluginBinDir, { recursive: true });

writeBundle({
  entryPath: resolve(here, "trace.ts"),
  outputPath: resolve(distDir, "trace.js"),
  pluginOutputPath: resolve(pluginBinDir, "trace.js"),
  runner: "trace",
});

writeBundle({
  entryPath: resolve(here, "claude-session-start-hook.ts"),
  outputPath: resolve(distDir, "claude-session-start-hook.js"),
  pluginOutputPath: resolve(pluginBinDir, "claude-session-start-hook.js"),
  runner: "hook",
});

function writeBundle(options: {
  entryPath: string;
  outputPath: string;
  pluginOutputPath: string;
  runner: "trace" | "hook";
}): void {
  const modules = collectModules(options.entryPath);
  const modulesByPath = new Map(modules.map((mod) => [mod.path, mod]));
  const moduleSources = Object.fromEntries(
    modules.map((mod) => [
      `${mod.id}.mjs`,
      rewriteImports(stripTypeScriptTypes(mod.source, { mode: "transform" }), {
        fromPath: mod.path,
        modulesByPath,
      }),
    ]),
  );
  const entryModule = modulesByPath.get(options.entryPath);
  if (!entryModule) {
    throw new Error(`Entry module was not collected: ${options.entryPath}`);
  }

  const runner =
    options.runner === "trace"
      ? `const result = entry.runTraceCli(process.argv.slice(2));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;`
      : `const input = readFileSync(0, "utf8");
const result = entry.runClaudeSessionStartHook(input);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;`;

  writeFileSync(
    options.outputPath,
    `#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const modules = ${JSON.stringify(moduleSources, null, 2)};
const bundleDir = mkdtempSync(join(tmpdir(), "trace-bundle-"));
for (const [name, source] of Object.entries(modules)) {
  writeFileSync(join(bundleDir, name), source);
}
const entry = await import(pathToFileURL(join(bundleDir, "${entryModule.id}.mjs")).href);
${runner}
`,
  );
  chmodSync(options.outputPath, 0o755);
  copyFileSync(options.outputPath, options.pluginOutputPath);
  chmodSync(options.pluginOutputPath, 0o755);
}

function collectModules(entryPath: string): CollectedModule[] {
  const modules: CollectedModule[] = [];
  const idsByPath = new Map<string, string>();

  function visit(path: string): void {
    const normalized = resolve(path);
    if (idsByPath.has(normalized)) return;

    const id = `mod_${idsByPath.size}`;
    idsByPath.set(normalized, id);
    const source = readFileSync(normalized, "utf8");
    modules.push({ id, path: normalized, source });

    for (const specifier of findModuleSpecifiers(source)) {
      const resolved = resolveBundledSpecifier(specifier, normalized);
      if (resolved) visit(resolved);
    }
  }

  visit(entryPath);
  return modules;
}

function findModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(moduleSpecifierPattern)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function rewriteImports(
  source: string,
  context: {
    fromPath: string;
    modulesByPath: Map<string, CollectedModule>;
  },
): string {
  return source.replaceAll(
    /((?:import|export)\s+(?:[^"']*?\s+from\s+)?["'])([^"']+)(["'])/g,
    (full, prefix: string, specifier: string, suffix: string) => {
      const resolved = resolveBundledSpecifier(specifier, context.fromPath);
      if (!resolved) return full;

      const target = context.modulesByPath.get(resolved);
      if (!target) {
        throw new Error(
          `Bundled import ${specifier} from ${relative(repoRoot, context.fromPath)} was not collected`,
        );
      }

      return `${prefix}./${target.id}.mjs${suffix}`;
    },
  );
}

function resolveBundledSpecifier(
  specifier: string,
  fromPath: string,
): string | null {
  if (specifier === "@trace/core") return coreEntry;
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith(".")) return resolve(dirname(fromPath), specifier);
  return null;
}
