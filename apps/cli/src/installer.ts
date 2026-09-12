// Kept as a diagnostic compatibility command for users arriving from the old
// plugin-based install. Points to the CLI-first setup path.

export function runInit(
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  void env;
  void cwd;

  const lines = [
    "EQNX is now installed as a persistent global CLI.",
    "Install: npm install -g @eqnx/cli  (or pnpm add -g / bun install -g)",
    "Setup:   eqnx setup",
    "Update:  eqnx update",
    "Remove:  eqnx setup --remove",
  ];

  return `${lines.join("\n")}\n`;
}
