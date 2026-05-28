declare module "node:assert/strict" {
  const assert: {
    deepEqual(actual: unknown, expected: unknown): void;
    equal(actual: unknown, expected: unknown): void;
    throws(fn: () => void, expected?: RegExp): void;
  };
  export default assert;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:fs" {
  export type Dirent = {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  };
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void): void;
}
