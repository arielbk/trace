import { configDefaults, defineConfig } from "vitest/config";

const packagingTests = ["src/bundle.test.ts", "src/distribution.test.ts"];

export default defineConfig({
  test: {
    setupFiles: ["./src/test-setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "cli",
          exclude: [...configDefaults.exclude, ...packagingTests],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "packaging",
          include: packagingTests,
          // Both suites rebuild apps/cli/dist. Keep the package snapshot intact
          // until its assertions finish, without serializing unrelated tests.
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
