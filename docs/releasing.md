# Releasing EQNX

Integrate reviewed work into main before releasing. Keep the source commit,
package version, tested tarball and release record tied together. Repository
renaming does not require republishing an existing version.

## Verify the candidate

Use the pinned pnpm version and Node 22.13 or later. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check-types
pnpm lint
pnpm build
pnpm -r --if-present test
pnpm test:evals
pnpm --filter @trace/web build:hosted
```

The CLI's packaging test project runs after the parallel tests and serializes
the two suites that rebuild dist. Keep this ordering when editing test config.
Hosted and bundled builds have separate output directories.

Update apps/cli/package.json and CHANGELOG.md in the release PR. Use the release
script with an explicit version and --dry-run to build and pack the candidate:

```sh
pnpm release:eqnx -- --version X.Y.Z --dry-run
shasum -a 256 dist/releases/eqnx-cli-X.Y.Z.tgz
```

Record the checksum and test the tarball with an isolated installation. Merge
the release PR and identify its exact source commit. Publish that tested
tarball rather than rebuilding a potentially different working tree:

```sh
npm publish dist/releases/eqnx-cli-X.Y.Z.tgz --access public --tag latest
```

Wait for npm processing, verify the latest tag, download the registry tarball
to a fresh directory and compare its checksum. Tag the exact source commit as
vX.Y.Z and create the GitHub release with the tested artifact and validation
notes. Never republish or retarget an existing version/tag.

## Hosted deployment

Follow [the hosted deployment runbook](hosted-deployment.md). Its --branch main
argument selects the Cloudflare production environment; it does not prove the
checked-out Git source is main. Record the source commit and deployment ID.
A client release and a static deployment are separate operations.

## Publishing authentication

Interactive npm publishing can request 2FA. For future automated releases,
configure npm trusted publishing for the final GitHub repository identity and
a specific release workflow/environment. That account-level configuration is
not established merely by checking in a workflow. See the official
[npm trusted-publishing guide](https://docs.npmjs.com/trusted-publishers/).
