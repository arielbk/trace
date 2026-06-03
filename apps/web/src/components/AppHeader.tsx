import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle.tsx";

/**
 * Persistent header shown on every page: wordmark linking back to the task
 * list, an optional context label (e.g. the current task's title), and the
 * theme toggle.
 */
export function AppHeader({ context }: { context?: string }) {
  return (
    <header className="app-header">
      <nav className="app-header-nav" aria-label="Primary">
        <Link to="/" className="app-wordmark">
          Trace
        </Link>
        {context ? (
          <>
            <span className="app-header-sep" aria-hidden="true">
              /
            </span>
            <span className="app-header-context">{context}</span>
          </>
        ) : null}
      </nav>
      <ThemeToggle />
    </header>
  );
}
