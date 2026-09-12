import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

declare global {
  var __webpack_nonce__: string | undefined;
}

// Radix's scroll lock injects a <style> element at runtime, which the hosted
// CSP only admits when it carries that build's nonce. `get-nonce` — the reader
// react-style-singleton stamps the element from — falls back to this global, so
// setting it before the first render is what keeps scroll lock working.
if (import.meta.env.VITE_STYLE_NONCE) {
  globalThis.__webpack_nonce__ = import.meta.env.VITE_STYLE_NONCE;
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
