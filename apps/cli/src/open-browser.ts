import { spawn as nodeSpawn } from "node:child_process";

type BrowserSpawn = (
  command: string,
  args: string[],
) => { unref: () => void; on: (event: string, handler: () => void) => void };

const defaultBrowserSpawn: BrowserSpawn = (command, args) =>
  nodeSpawn(command, args, { detached: true, stdio: "ignore" });

/**
 * Open `url` in the user's default browser. Best-effort: failures are ignored —
 * callers should still print the URL so it remains usable as a fallback.
 */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: BrowserSpawn = defaultBrowserSpawn,
): void {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url] as string[]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url] as string[]]
        : ["xdg-open", [url] as string[]];
  try {
    const child = spawn(command as string, args as string[]);
    child.on("error", () => {});
    child.unref();
  } catch {
    // Browser launch is a convenience; never fail the command over it.
  }
}
