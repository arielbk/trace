import { BrowserRouter, Route, Routes } from "react-router-dom";
import { TasksPage } from "./pages/TasksPage.tsx";
import { TaskPage } from "./pages/TaskPage.tsx";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TasksPage />} />
        <Route path="/task/:id" element={<TaskPage />} />
      </Routes>
    </BrowserRouter>
  );
}
