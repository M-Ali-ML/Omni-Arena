import { useArenaLeaderboard } from "@omni-arena/react";
import ComponentNotice from "../leaderboard/ComponentNotice";
import RankShiftBump from "../charts/RankShiftBump";
import RatingForestPlot from "../charts/RatingForestPlot";
import StyleDumbbell from "../charts/StyleDumbbell";
import VoteOutcomeBars from "../charts/VoteOutcomeBars";
import WinRateLollipop from "../charts/WinRateLollipop";

export default function RankingsTab() {
  const leaderboard = useArenaLeaderboard();

  return (
    <div className="tab-panel">
      {leaderboard.error && (
        <p className="error-banner">{leaderboard.error}</p>
      )}
      <ComponentNotice components={leaderboard.components} />
      <div className="chart-grid">
        <WinRateLollipop models={leaderboard.models} />
        <RatingForestPlot models={leaderboard.models} />
        <StyleDumbbell models={leaderboard.models} />
        <RankShiftBump models={leaderboard.models} />
        <VoteOutcomeBars models={leaderboard.models} />
      </div>
    </div>
  );
}
