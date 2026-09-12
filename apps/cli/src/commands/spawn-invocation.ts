/** The shape a platform needs in order to launch a command. */
export type SpawnInvocation = {
  command: string;
  args: string[];
  shell: boolean;
};

/**
 * Wraps a token in double quotes when the shell would otherwise split it. The
 * values reaching here are package-manager names, npm specifiers and a
 * registry-recorded install path — spaces are the only separator in play, and
 * cmd.exe strips a wrapping pair before the child sees the token.
 */
function quote(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

/**
 * Answers one question: given a command and its arguments, what shape does this
 * platform need in order to launch it?
 *
 * On Windows both spawn targets are batch shims — the package managers
 * (`npm.cmd`, `pnpm.cmd`) and the installed EQNX CLI at its registry-recorded
 * path — and Node has refused to launch `.cmd`/`.bat` without a shell since the
 * CVE-2024-27980 fix, throwing EINVAL. The shell therefore has to stay. But a
 * non-empty args array alongside `shell: true` is exactly what raises Node's
 * DEP0190 deprecation warning, so the arguments are folded into a single
 * pre-quoted command string instead — the remediation the deprecation asks for.
 *
 * Elsewhere a shell only adds a parsing layer, so it stays off and the argument
 * array is passed through untouched.
 */
export function spawnInvocation(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
): SpawnInvocation {
  if (platform !== "win32") return { command, args, shell: false };
  return { command: [command, ...args].map(quote).join(" "), args: [], shell: true };
}
