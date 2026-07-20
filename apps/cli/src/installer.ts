// Kept as a diagnostic compatibility command for users arriving from the old
// plugin-based install. Points to the CLI-first setup path.

export function runInit(
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  void env;
  void cwd;

  const lines = [
    "Trace is now installed as a persistent global CLI.",
    "Install: npm install -g @arielbk/trace  (or pnpm add -g / bun install -g)",
    "Setup:   trace setup",
    "Update:  trace update",
    "Remove:  trace setup --remove",
  ];

  return `${lines.join("\n")}\n`;
}
