import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { traceApiPlugin } from "./src/server/api-plugin.ts";

export default defineConfig({
  plugins: [react(), traceApiPlugin()],
  server: {
    port: 3000,
  },
});
