# CLI link

Install the repo-local `trace` command with:

```sh
pnpm link --global
```

The root `package.json` exposes the `trace` bin at `apps/cli/src/trace.ts`, so
the linked command runs the existing TypeScript CLI entry directly under Node.
No publish step or build artifact is required.
