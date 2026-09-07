import { createHash } from "node:crypto";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { traceApiPlugin } from "./src/server/api-plugin.ts";

export default defineConfig(({ command, mode }) => {
  const plugins: PluginOption[] = [tailwindcss(), react(), traceApiPlugin()];
  if (command === "build" && mode === "hosted") {
    const env = loadEnv(mode, import.meta.dirname, "");
    plugins.push(hostedContentSecurityPolicy(env.VITE_TRACE_API_ORIGIN));
  }

  return {
    plugins,
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
): Plugin {
  const apiOrigin = resolveHostedApiOrigin(apiOriginValue);

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
          "style-src-elem 'self'",
          "style-src-attr 'unsafe-inline'",
          "img-src 'self'",
          "font-src 'self'",
          `connect-src 'self' ${apiOrigin}`,
        ].join("; ");

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
