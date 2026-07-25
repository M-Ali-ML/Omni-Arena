import { useState } from "react";
import {
  useArenaLeaderboard,
  useArenaModelMetrics,
  useArenaSummary,
  type LeaderboardModel,
  type ModelMetricsEntry,
} from "@omni-arena/react";
import LatencyRangeBars, {
  formatMs,
  type LatencyMetric,
} from "../charts/LatencyRangeBars";
import PositionBiasDumbbell from "../charts/PositionBiasDumbbell";
import StyleDumbbell from "../charts/StyleDumbbell";
import WinRateScatter, { type ScatterPoint } from "../charts/WinRateScatter";
import StyleControlPanel from "../leaderboard/StyleControlPanel";

function scatterPoints(
  metrics: ModelMetricsEntry[],
  leaderboard: LeaderboardModel[],
  pick: (entry: ModelMetricsEntry) => number | null,
): ScatterPoint[] {
  const board = new Map(leaderboard.map((model) => [model.id, model]));
  const points: ScatterPoint[] = [];
  for (const entry of metrics) {
    const model = board.get(entry.id);
    const x = pick(entry);
    const games = model ? model.wins + model.losses + model.ties : 0;
    if (model && x !== null && games > 0) {
      points.push({ name: entry.displayName, x, y: model.winRate, games });
    }
  }
  return points;
}

export default function StyleBiasTab() {
  const leaderboard = useArenaLeaderboard();
  const metrics = useArenaModelMetrics();
  const summary = useArenaSummary();
  const [latencyMetric, setLatencyMetric] = useState<LatencyMetric>("ttft");

  const metricEntries = metrics.data?.models ?? [];
  const decidedGames =
    (summary.data?.slotAWins ?? 0) + (summary.data?.slotBWins ?? 0);
  const globalSlotAShare =
    decidedGames === 0 ? null : (summary.data?.slotAWins ?? 0) / decidedGames;

  const latencyToggle = (
    <>
      <button
        type="button"
        className={latencyMetric === "ttft" ? "active" : ""}
        onClick={() => setLatencyMetric("ttft")}
      >
        First token
      </button>
      <button
        type="button"
        className={latencyMetric === "duration" ? "active" : ""}
        onClick={() => setLatencyMetric("duration")}
      >
        Full stream
      </button>
    </>
  );

  return (
    <div className="tab-panel">
      {leaderboard.error && <p className="error-banner">{leaderboard.error}</p>}
      <div className="chart-grid">
        <StyleControlPanel styleControl={leaderboard.styleControl} />
        <PositionBiasDumbbell
          metrics={metricEntries}
          globalSlotAShare={globalSlotAShare}
        />
        <StyleDumbbell models={leaderboard.models} />
        <WinRateScatter
          title="Does longer win?"
          subtitle="Mean response length in tokens against overall win rate. Bubble area is the number of judged games."
          xLabel="mean output tokens"
          points={scatterPoints(metricEntries, leaderboard.models, (entry) =>
            entry.meanOutputTokens,
          )}
          emptyMessage="Needs voted matchups with recorded token counts."
        />
        <WinRateScatter
          title="Does faster win?"
          subtitle="Median latency against overall win rate — fast and high is the ideal corner."
          xLabel={latencyMetric === "ttft" ? "median TTFT" : "median stream time"}
          xFormat={formatMs}
          points={scatterPoints(metricEntries, leaderboard.models, (entry) =>
            latencyMetric === "ttft" ? entry.ttftMsP50 : entry.durationMsP50,
          )}
          emptyMessage="Needs voted matchups with recorded latencies."
          actions={latencyToggle}
        />
        <WinRateScatter
          title="Does prettier win?"
          subtitle="Markdown density (headers, lists, bold, code) against overall win rate."
          xLabel="markdown density"
          xFormat={(value) => value.toFixed(2)}
          points={scatterPoints(metricEntries, leaderboard.models, (entry) =>
            entry.meanMarkdownDensity,
          )}
          emptyMessage="Needs voted matchups with recorded formatting stats."
        />
        <LatencyRangeBars
          metrics={metricEntries}
          metric={latencyMetric}
          actions={latencyToggle}
        />
      </div>
    </div>
  );
}
