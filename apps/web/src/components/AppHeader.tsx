import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle.tsx";

export function AppHeader({
  project,
  context,
}: {
  project?: string;
  context?: string;
}) {
  return (
    <header className="flex items-center justify-between gap-4 pb-3 mb-5 border-b border-border">
      <nav
        className="flex items-center gap-3 min-w-0"
        aria-label="Primary"
      >
        <Link
          to="/"
          className="font-extrabold tracking-wide no-underline font-mono hover:text-accent"
        >
          Trace
        </Link>
        {project ? (
          <>
            <span className="text-text-muted" aria-hidden="true">
              /
            </span>
            <span className="text-text-muted">{project}</span>
          </>
        ) : null}
        {context ? (
          <>
            <span className="text-text-muted" aria-hidden="true">
              /
            </span>
            <span className="min-w-0 overflow-hidden text-text-muted whitespace-nowrap text-ellipsis">
              {context}
            </span>
          </>
        ) : null}
      </nav>
      <ThemeToggle />
    </header>
  );
}
