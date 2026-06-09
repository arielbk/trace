import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle.tsx";

/**
 * Persistent header shown on every page: wordmark linking back to the task
 * list, an optional project segment and context label (e.g. the current
 * task's title) forming a breadcrumb, and the theme toggle. The project
 * segment is where page orientation lives — it tells the user which project
 * the current task belongs to without a separate on-page badge.
 */
export function AppHeader({
  project,
  context,
}: {
  project?: string;
  context?: string;
}) {
  return (
    <header className="app-header">
      <nav className="app-header-nav" aria-label="Primary">
        <Link to="/" className="app-wordmark">
          Trace
        </Link>
        {project ? (
          <>
            <span className="app-header-sep" aria-hidden="true">
              /
            </span>
            <span className="app-header-project">{project}</span>
          </>
        ) : null}
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
