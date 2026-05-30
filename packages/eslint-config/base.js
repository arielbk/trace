import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";
import onlyWarn from "eslint-plugin-only-warn";

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    // Tests routinely read/mutate process.env (e.g. HOME, TRACE_DB) to set up
    // fixtures. The turbo env-var rule guards build-affecting source, not tests.
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "turbo/no-undeclared-env-vars": "off",
    },
  },
  {
    ignores: ["dist/**"],
  },
];
