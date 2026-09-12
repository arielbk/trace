import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { traceApiPlugin } from "./src/server/api-plugin.ts";

export default defineConfig(({ command, mode }) => {
  const plugins: PluginOption[] = [tailwindcss(), react(), traceApiPlugin()];
  // Radix's scroll lock injects one <style> element at runtime whose text
  // carries the viewer's scrollbar width, so its hash differs per machine and
  // the policy cannot pin it. A nonce minted per build lets that single
  // element through while `style-src-elem` stays shut to everything else.
  const styleNonce =
    command === "build" && mode === "hosted"
      ? randomBytes(16).toString("base64")
      : "";
  if (styleNonce) {
    const env = loadEnv(mode, import.meta.dirname, "");
    plugins.push(
      hostedContentSecurityPolicy(env.VITE_TRACE_API_ORIGIN, styleNonce),
    );
  }

  return {
    plugins,
    define: {
      "import.meta.env.VITE_STYLE_NONCE": JSON.stringify(styleNonce),
    },
    build: {
      outDir: mode === "hosted" ? "dist-hosted" : "dist",
    },
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      port: 3000,
    },
  };
});

function hostedContentSecurityPolicy(
  apiOriginValue: string | undefined,
  styleNonce: string,
): Plugin {
  const apiOrigin = resolveHostedApiOrigin(apiOriginValue);
  let contentSecurityPolicy: string | undefined;

  return {
    name: "trace-hosted-content-security-policy",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const scriptHashes = [
          ...html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/g),
        ]
          .map((match) => match[1])
          .filter((script): script is string => Boolean(script?.trim()))
          .map(
            (script) =>
              `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
          );
        const policy = [
          "default-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          ["script-src 'self'", ...scriptHashes].join(" "),
          `style-src-elem 'self' 'nonce-${styleNonce}'`,
          "style-src-attr 'unsafe-inline'",
          "img-src 'self'",
          "font-src 'self'",
          `connect-src 'self' ${apiOrigin}`,
        ].join("; ");
        contentSecurityPolicy = policy;

        return [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: policy,
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
    generateBundle: {
      order: "post",
      handler() {
        if (!contentSecurityPolicy) {
          throw new Error("Hosted HTML must generate its CSP before deployment headers");
        }
        this.emitFile({
          type: "asset",
          fileName: "_headers",
          source: [
            "/*",
            `  Content-Security-Policy: ${contentSecurityPolicy}; frame-ancestors 'none'`,
            "  X-Content-Type-Options: nosniff",
            "  X-Frame-Options: DENY",
            "  Referrer-Policy: no-referrer",
            "",
          ].join("\n"),
        });
      },
    },
  };
}

function resolveHostedApiOrigin(value: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error(
      "Hosted builds require VITE_TRACE_API_ORIGIN to be an exact HTTP 127.0.0.1 origin",
    );
  }
}
