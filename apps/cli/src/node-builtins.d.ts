declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode?: number;
  stderr: { write(value: string): void };
  stdout: { write(value: string): void };
};

interface ImportMeta {
  url: string;
}

declare module "node:assert/strict" {
  const assert: {
    deepEqual(actual: unknown, expected: unknown): void;
    equal(actual: unknown, expected: unknown): void;
    match(actual: string, expected: RegExp): void;
  };
  export default assert;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { encoding: "utf8"; env: Record<string, string | undefined>; input?: string },
  ): string;
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void): void;
}
