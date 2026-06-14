import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle.tsx";

export function AppHeader({
  project,
  context,
  bordered = true,
}: {
  project?: string;
  context?: string;
  bordered?: boolean;
}) {
  return (
    <header
      className={`flex items-center justify-between gap-4 py-header-y ${
        bordered ? "border-b border-border" : ""
      }`}
    >
      <nav
        className="flex items-center gap-2.5 min-w-0"
        aria-label="Primary"
      >
        <Link
          to="/"
          className="font-mono font-extrabold text-base no-underline text-text hover:text-accent"
        >
          Trace
        </Link>
        {project ? (
          <>
            <span className="text-text-muted" aria-hidden="true">
              /
            </span>
            <span className="font-mono text-crumb text-text-muted">
              {project}
            </span>
          </>
        ) : null}
        {context ? (
          <>
            <span className="text-text-muted" aria-hidden="true">
              /
            </span>
            <span className="min-w-0 overflow-hidden font-mono text-crumb text-text-muted whitespace-nowrap text-ellipsis">
              {context}
            </span>
          </>
        ) : null}
      </nav>
      <ThemeToggle />
    </header>
  );
}
