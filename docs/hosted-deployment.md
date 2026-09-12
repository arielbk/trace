# Deploy the hosted board

The board is a static Cloudflare Pages application at `https://app.eqnx.ai`.
Deploy it in the app owner's Cloudflare account. The `eqnx.ai` DNS zone can
remain in a separate account; no zone or registrar transfer is needed.
Only the built UI is uploaded. The board accesses the EQNX API on each user's
computer at `http://127.0.0.1:4317`. That local service stores tasks and can sync
them to the separately deployed EQNX Cloud service. Browser-only cloud access
is planned; the current hosted board still requires a local connection.

## First deployment

Use Node 22 or later and the repository's pinned pnpm version. From the repo root:

```sh
pnpm install --frozen-lockfile
npx --yes wrangler@4.110.0 login
npx --yes wrangler@4.110.0 whoami
export CLOUDFLARE_ACCOUNT_ID='<hosting-account-id>'
pnpm --filter @trace/web exec npx --yes wrangler@4.110.0 pages project create eqnx-app --production-branch main
pnpm --filter @trace/web deploy:hosted --branch main
```

Verify the account before creating the project. Reuse an existing `eqnx-app`
project if it is already present. The deploy script builds the hosted mode,
then uploads only `apps/web/dist-hosted`; the bundled local UI has a separate
build output. Wrangler is pinned in the deploy command.

`--branch main` promotes this build to production, regardless of the checked-out
branch. Deploy only a reviewed commit. For an isolated preview, use another
branch name. Preview origins require an explicit local `TRACE_WEB_ORIGIN`
override to pair; production uses the default `https://app.eqnx.ai`.

## Connect the domain across accounts

1. In the hosting account, open the Pages project's **Custom domains**, and
   register `app.eqnx.ai`.
2. Read the actual `*.pages.dev` hostname returned for the project.
3. In the account managing `eqnx.ai`, add a **DNS-only CNAME** named `app`
   pointing to that hostname. Do not overwrite an existing record without
   inspecting its purpose.
4. Wait for the Pages custom domain and HTTPS certificate to become active.
5. Configure the apex redirect in the DNS-zone account: requests for `eqnx.ai`
   should redirect to `https://app.eqnx.ai`, preserving paths and query strings.
   Inspect existing apex routing first. Do not redirect `app.eqnx.ai` itself.

Register the custom domain on Pages before adding the CNAME. DNS-only here
avoids placing another Cloudflare proxy in front of the Pages deployment;
Pages still serves the app through Cloudflare with HTTPS.

## Verification

- Confirm the homepage and a direct task route both serve the application.
  Pages provides SPA fallback because the build has no root `404.html`.
- Confirm the response CSP matches the build's inline-script hashes and style
  nonce, allows only the intended loopback API, and includes `frame-ancestors
  'none'`. Hosted builds generate `_headers` alongside `index.html`.
- In Chrome and Firefox, allow local-device access, approve pairing in Terminal,
  revisit, and exercise disconnect/recovery and revoked access.
- A first deployment does not update the installed CLI. Use a CLI candidate
  containing the matching protocol and default hosted origin for acceptance.

## Subsequent deployments

```sh
export CLOUDFLARE_ACCOUNT_ID='<hosting-account-id>'
pnpm --filter @trace/web deploy:hosted --branch main
```

This uses a Direct Upload Pages project. Cloudflare cannot convert that project
to its built-in Git integration later. Automatic deployment can instead run
this same command in GitHub Actions, with a Pages deployment token stored as a
CI secret. No Cloudflare token belongs in this repository.

References: [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/),
[custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/),
[headers](https://developers.cloudflare.com/pages/configuration/headers/).
