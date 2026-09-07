import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { TasksPage } from "./pages/TasksPage.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";
import { queryClient } from "./lib/query-client.ts";
import { useServerSyncOnFocus } from "./lib/api.ts";
import { LocalTraceConnection } from "./components/LocalTraceConnection.tsx";
import {
  defaultTraceDataSource,
  TraceDataSourceProvider,
  useTraceDataSource,
  type TraceDataSource,
} from "./lib/trace-data-source.ts";

function AppRoutes() {
  const source = useTraceDataSource();
  useServerSyncOnFocus(source.capabilities.sync);
  const routes = (
    <Routes>
      <Route path="/" element={<TasksPage />} />
      {source.capabilities.taskDetails ? (
        <>
          <Route path="/task/:id" element={<TaskPage />} />
          <Route path="/task/:id/docs/*" element={<TaskPage />} />
        </>
      ) : null}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );

  return source.capabilities.requiresConnection ? (
    <LocalTraceConnection>{routes}</LocalTraceConnection>
  ) : (
    routes
  );
}

export function App({
  source = defaultTraceDataSource,
}: {
  source?: TraceDataSource;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <TraceDataSourceProvider source={source}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </TraceDataSourceProvider>
    </QueryClientProvider>
  );
}
