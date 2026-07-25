import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import ArenaPage from "./routes/ArenaPage";

// The insights dashboard (and its charting dependencies) is lazy-loaded so
// the voting arena stays a small first paint.
const InsightsPage = lazy(() => import("./routes/InsightsPage"));
const RankingsTab = lazy(() => import("./dashboard/RankingsTab"));
const HeadToHeadTab = lazy(() => import("./dashboard/HeadToHeadTab"));
const StyleBiasTab = lazy(() => import("./dashboard/StyleBiasTab"));
const ActivityTab = lazy(() => import("./dashboard/ActivityTab"));

export default function App() {
  return (
    <BrowserRouter>
      <nav className="top-nav" aria-label="Primary">
        <span className="brand">OMNIARENA</span>
        <div className="top-nav-links">
          <NavLink to="/" end>
            Arena
          </NavLink>
          <NavLink to="/insights">Insights</NavLink>
        </div>
      </nav>
      <Suspense fallback={<main><p className="chart-empty">Loading…</p></main>}>
        <Routes>
          <Route path="/" element={<ArenaPage />} />
          <Route path="/insights" element={<InsightsPage />}>
            <Route index element={<Navigate to="rankings" replace />} />
            <Route path="rankings" element={<RankingsTab />} />
            <Route path="head-to-head" element={<HeadToHeadTab />} />
            <Route path="style" element={<StyleBiasTab />} />
            <Route path="activity" element={<ActivityTab />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
