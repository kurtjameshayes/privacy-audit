import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import GatherPage from "./pages/GatherPage";
import PoliciesPage from "./pages/PoliciesPage";
import CompliancePage from "./pages/CompliancePage";
import AdvisorPage from "./pages/AdvisorPage";
import AlertsPage from "./pages/AlertsPage";
import RunsPage from "./pages/RunsPage";
import ReportsPage from "./pages/ReportsPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/gather" replace />} />
          <Route path="gather" element={<GatherPage />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="compliance" element={<CompliancePage />} />
          <Route path="advisor" element={<AdvisorPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="reports" element={<ReportsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/gather" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
