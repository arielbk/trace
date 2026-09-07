import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { TasksPage } from "./pages/TasksPage.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";
import { queryClient } from "./lib/query-client.ts";
import { useServerSyncOnFocus } from "./lib/api.ts";
import { usesRemoteTraceApi } from "./lib/api-origin.ts";
import { LocalTraceConnection } from "./components/LocalTraceConnection.tsx";

export function App() {
  useServerSyncOnFocus(!usesRemoteTraceApi);
  const routes = (
    <Routes>
      <Route path="/" element={<TasksPage readOnly={usesRemoteTraceApi} />} />
      {usesRemoteTraceApi ? null : (
        <>
          <Route path="/task/:id" element={<TaskPage />} />
          <Route path="/task/:id/docs/*" element={<TaskPage />} />
        </>
      )}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {usesRemoteTraceApi ? (
          <LocalTraceConnection>{routes}</LocalTraceConnection>
        ) : (
          routes
        )}
      </BrowserRouter>
    </QueryClientProvider>
  );
}
