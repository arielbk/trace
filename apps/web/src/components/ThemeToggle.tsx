import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import {
  applyTheme,
  nextTheme,
  resolveInitialTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from "../theme.ts";

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
      className="inline-flex items-center justify-center size-8 rounded-full border border-border text-text-muted hover:text-text hover:border-border-strong transition-colors cursor-pointer"
      aria-label="Toggle color theme"
      aria-pressed={isDark}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={handleToggle}
    >
      {isDark ? (
        <Moon size={14} aria-hidden="true" />
      ) : (
        <Sun size={14} aria-hidden="true" />
      )}
    </button>
  );
}
