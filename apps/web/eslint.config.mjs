import { config } from "@repo/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // Headless primitives are wrapped once in src/components/ui and consumed
    // from there. Importing them directly re-scatters the styling and the
    // force-mount/animation plumbing across the board, which is exactly what
    // the wrappers exist to prevent.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@radix-ui/*"],
              message:
                "Import the wrapper from src/components/ui instead of the Radix primitive. Add a wrapper there if one does not exist yet.",
            },
          ],
        },
      ],
    },
  },
];
