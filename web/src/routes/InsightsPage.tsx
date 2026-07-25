import { useArenaSummary } from "@omni-arena/react";
import { NavLink, Outlet } from "react-router-dom";
import GettingStartedNotice from "../dashboard/GettingStartedNotice";
import SummaryStrip from "../dashboard/SummaryStrip";

const tabs = [
  { to: "rankings", label: "Rankings" },
  { to: "head-to-head", label: "Head-to-head" },
  { to: "style", label: "Style & bias" },
  { to: "activity", label: "Activity" },
];

export default function InsightsPage() {
  // Fetched once here and passed down: the strip and the setup notice read the
  // same aggregate, and each self-fetching would double the request.
  const summary = useArenaSummary();

  return (
    <main className="insights">
      <header className="hero">
        <p className="eyebrow">OMNIARENA / INSIGHTS</p>
        <h1>Model insights</h1>
        <p className="intro">
          Scores, Bradley-Terry ratings, and the stories behind them: who beats
          whom, what style buys, and how the arena is sampling.
        </p>
      </header>
      <SummaryStrip data={summary.data} error={summary.error} />
      <GettingStartedNotice summary={summary.data} />
      <nav className="tab-nav" aria-label="Insight views">
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </main>
  );
}
