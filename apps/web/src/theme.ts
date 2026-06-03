/**
 * Theme resolution and application. The resolution logic is kept pure and
 * DOM-free so it can be unit-tested in the node test environment; the browser
 * wiring (localStorage, matchMedia, document) lives in `applyTheme` and the
 * `ThemeToggle` component, which only run in the real DOM.
 */

export type Theme = "light" | "dark";

/** localStorage key holding an explicit user override of the OS preference. */
export const THEME_STORAGE_KEY = "trace.theme";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark";
}

/**
 * Resolve the theme to show on load: an explicit stored override always wins;
 * otherwise the OS `prefers-color-scheme` decides.
 */
export function resolveInitialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (isTheme(stored)) return stored;
  return prefersDark ? "dark" : "light";
}

/** The theme you get by toggling away from the current one. */
export function nextTheme(current: Theme): Theme {
  return current === "dark" ? "light" : "dark";
}

/** Reflect the active theme on the document root via `data-theme`. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}
