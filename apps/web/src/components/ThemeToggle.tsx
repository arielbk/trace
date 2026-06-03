import { useEffect, useState } from "react";
import {
  applyTheme,
  nextTheme,
  resolveInitialTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from "../theme.ts";

/**
 * Header control that flips the page between light and dark. On mount it
 * syncs to the theme already resolved on the document root (set pre-paint by
 * the bootstrap script in `index.html`), so OS preference wins on first visit
 * and a stored override survives reloads. Toggling persists the choice.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current === "light" || current === "dark") {
      setTheme(current);
      return;
    }
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initial = resolveInitialTheme(stored, prefersDark);
    setTheme(initial);
    applyTheme(initial);
  }, []);

  function handleToggle() {
    setTheme((current) => {
      const next = nextTheme(current);
      localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label="Toggle color theme"
      aria-pressed={isDark}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={handleToggle}
    >
      <span aria-hidden="true">{isDark ? "🌙" : "☀️"}</span>
    </button>
  );
}
