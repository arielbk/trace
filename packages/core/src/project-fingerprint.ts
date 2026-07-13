import { execFileSync } from "node:child_process";

export interface ProjectFingerprints {
  remoteUrl?: string;
  rootCommit?: string;
}

function gitOutput(rootDir: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function normalizedRepositoryPath(pathname: string): string {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
}

function normalizeRemoteUrl(remoteUrl: string): string | undefined {
  if (!remoteUrl.includes("://")) {
    const scpLike = remoteUrl.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (scpLike?.[1] && scpLike[2]) {
      return `${scpLike[1].toLowerCase()}/${normalizedRepositoryPath(scpLike[2])}`;
    }
  }

  try {
    const parsed = new URL(remoteUrl);
    if (!parsed.hostname) return undefined;

    const defaultPort =
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "ssh:" && parsed.port === "22");
    const host = `${parsed.hostname.toLowerCase()}${parsed.port && !defaultPort ? `:${parsed.port}` : ""}`;
    const path = normalizedRepositoryPath(parsed.pathname);
    return path ? `${host}/${path}` : undefined;
  } catch {
    return undefined;
  }
}

export function readProjectFingerprints(
  rootDir: string,
): ProjectFingerprints {
  const remoteUrl = gitOutput(rootDir, ["config", "--get", "remote.origin.url"]);
  const normalizedRemoteUrl = remoteUrl
    ? normalizeRemoteUrl(remoteUrl)
    : undefined;
  const isShallow = gitOutput(rootDir, [
    "rev-parse",
    "--is-shallow-repository",
  ]);
  const rootCommits =
    isShallow === "false"
      ? gitOutput(rootDir, ["rev-list", "--max-parents=0", "HEAD"])
      : undefined;
  const rootCommit = rootCommits?.split(/\s+/).sort()[0];

  return {
    ...(normalizedRemoteUrl ? { remoteUrl: normalizedRemoteUrl } : {}),
    ...(rootCommit ? { rootCommit } : {}),
  };
}
