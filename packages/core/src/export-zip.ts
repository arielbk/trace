import { strToU8, unzipSync, zipSync } from "fflate";
import type { BundleFile } from "./export-bundle.ts";

export function zipExportBundle(files: BundleFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    if (
      file.path.endsWith("/") &&
      files.some(
        (other) => other.path.startsWith(file.path) && other.path !== file.path,
      )
    ) {
      continue;
    }
    entries[file.path] = toBytes(file.contents);
  }
  return zipSync(entries);
}

export function unzipExportBundle(
  zipBytes: Uint8Array,
): Record<string, Uint8Array> {
  return unzipSync(zipBytes);
}

function toBytes(contents: string | Uint8Array): Uint8Array {
  return typeof contents === "string" ? strToU8(contents) : contents;
}
