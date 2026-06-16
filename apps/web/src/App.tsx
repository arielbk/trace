import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { TasksPage } from "./pages/TasksPage.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";
import { queryClient } from "./lib/query-client.ts";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<TasksPage />} />
          <Route path="/task/:id" element={<TaskPage />} />
          <Route path="/task/:id/docs/*" element={<TaskPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
