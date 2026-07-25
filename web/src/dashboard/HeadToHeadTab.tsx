import { useState } from "react";
import {
  useArenaHeadToHead,
  useArenaLeaderboard,
  useArenaModelMetrics,
} from "@omni-arena/react";
import ConnectivityCallout from "../charts/ConnectivityCallout";
import HeadToHeadMatrix, {
  pairKey,
  type MatrixMetric,
} from "../charts/HeadToHeadMatrix";
import PairDrilldown from "../charts/PairDrilldown";
import TieRateBars from "../charts/TieRateBars";

export default function HeadToHeadTab() {
  const headToHead = useArenaHeadToHead();
  const metrics = useArenaModelMetrics();
  const leaderboard = useArenaLeaderboard();
  const [metric, setMetric] = useState<MatrixMetric>("winRate");
  const [selectedPairKey, setSelectedPairKey] = useState<string | null>(null);

  const models = headToHead.data?.models ?? [];
  const pairs = headToHead.data?.pairs ?? [];
  const selectedPair =
    pairs.find(
      (pair) => pairKey(pair.modelAId, pair.modelBId) === selectedPairKey,
    ) ?? null;

  return (
    <div className="tab-panel">
      {headToHead.error && <p className="error-banner">{headToHead.error}</p>}
      <div className="chart-grid">
        <HeadToHeadMatrix
          models={models}
          pairs={pairs}
          metric={metric}
          onMetricChange={setMetric}
          selectedPairKey={selectedPairKey}
          onSelectPair={setSelectedPairKey}
        />
        <PairDrilldown
          pair={selectedPair}
          models={models}
          metrics={metrics.data?.models ?? []}
        />
        <TieRateBars models={models} pairs={pairs} />
        <ConnectivityCallout models={leaderboard.models} />
      </div>
    </div>
  );
}
