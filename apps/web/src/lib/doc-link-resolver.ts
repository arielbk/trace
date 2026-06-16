export type ResolveTaskDocLinkOptions = {
  href: string;
  baseDocPath: string;
  knownDocPaths: readonly string[];
  taskRef: string;
};

export function resolveTaskDocLink({
  href,
  baseDocPath,
  knownDocPaths,
  taskRef,
}: ResolveTaskDocLinkOptions): string | null {
  const rawHref = href.trim();
  if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("//")) {
    return null;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref)) return null;

  const hrefPath = decodeHrefPath(rawHref.split(/[?#]/, 1)[0] ?? "");
  if (!hrefPath || !isMarkdownPath(hrefPath)) return null;

  const knownPaths = new Set(knownDocPaths.map(normalizeDocPath));
  const docsRoot = taskDocsRoot(baseDocPath, [...knownPaths]);
  const candidate = normalizeDocPath(
    hrefPath.startsWith("/")
      ? resolveRootRelativePath(hrefPath, docsRoot, knownPaths)
      : joinDocPath(baseDir(baseDocPath, docsRoot), hrefPath),
  );

  if (!knownPaths.has(candidate)) return null;

  return `/task/${encodeURIComponent(taskRef)}/docs/${encodeURIComponent(candidate)}`;
}

function decodeHrefPath(hrefPath: string): string {
  try {
    return decodeURIComponent(hrefPath);
  } catch {
    return hrefPath;
  }
}

function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

function resolveRootRelativePath(
  hrefPath: string,
  docsRoot: string,
  knownPaths: Set<string>,
): string {
  const normalizedHref = normalizeDocPath(hrefPath);
  if (knownPaths.has(normalizedHref)) return normalizedHref;

  return joinDocPath(docsRoot, hrefPath);
}

function taskDocsRoot(baseDocPath: string, knownDocPaths: string[]): string {
  const marker = "/docs/";
  const markerIndex = baseDocPath.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return baseDocPath.slice(0, markerIndex + "/docs".length);
  }

  const knownPathWithDocsMarker = knownDocPaths.find((path) =>
    path.includes(marker),
  );
  if (knownPathWithDocsMarker) {
    const knownMarkerIndex = knownPathWithDocsMarker.lastIndexOf(marker);
    return knownPathWithDocsMarker.slice(0, knownMarkerIndex + "/docs".length);
  }

  const dirs =
    knownDocPaths.length > 0
      ? knownDocPaths.map(dirname)
      : [baseDocPath].map(dirname);
  return commonPathPrefix(dirs);
}

function baseDir(baseDocPath: string, docsRoot: string): string {
  if (baseDocPath.startsWith("/")) return dirname(baseDocPath);
  return joinDocPath(docsRoot, dirname(baseDocPath));
}

function dirname(path: string): string {
  const normalized = normalizeDocPath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function joinDocPath(base: string, relativePath: string): string {
  const parts = `${base}/${relativePath}`.split("/");
  const resolved: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return `/${resolved.join("/")}`;
}

function normalizeDocPath(path: string): string {
  const normalized = joinDocPath("/", path);
  return path.startsWith("/") ? normalized : normalized.slice(1);
}

function commonPathPrefix(paths: string[]): string {
  const [first, ...rest] = paths.map((path) => path.split("/").filter(Boolean));
  if (!first) return "/";

  let common = first.length;
  for (const path of rest) {
    while (
      common > 0 &&
      first.slice(0, common).join("/") !== path.slice(0, common).join("/")
    ) {
      common -= 1;
    }
  }

  return `/${first.slice(0, common).join("/")}`;
}
