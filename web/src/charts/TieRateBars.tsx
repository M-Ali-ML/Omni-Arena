import type { AnalyticsModelRef, HeadToHeadPair } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { formatPercent } from "./theme";

interface TieRateBarsProps {
  models: AnalyticsModelRef[];
  pairs: HeadToHeadPair[];
}

/**
 * Tie share per sampled pair: pairs users repeatedly cannot separate
 * (both good / both bad) float to the top.
 */
export default function TieRateBars({ models, pairs }: TieRateBarsProps) {
  const names = new Map(models.map((model) => [model.id, model.displayName]));
  const rows = pairs
    .filter((pair) => pair.games > 0)
    .map((pair) => ({
      key: `${pair.modelAId}|${pair.modelBId}`,
      label: `${names.get(pair.modelAId) ?? "?"} · ${names.get(pair.modelBId) ?? "?"}`,
      tieRate: pair.ties / pair.games,
      ties: pair.ties,
      games: pair.games,
    }))
    .sort((a, b) => b.tieRate - a.tieRate);

  return (
    <ChartCard
      title="Indistinguishable pairs"
      subtitle="Share of each pair's games that ended in a tie vote. High bars mean users cannot tell those two models apart."
      emptyMessage={rows.length === 0 ? "No sampled pairs yet." : null}
    >
      <div className="tie-bars">
        {rows.map((row) => (
          <div className="lollipop-row tie-row" key={row.key}>
            <span className="row-label" title={row.label}>
              {row.label}
            </span>
            <div className="tie-track">
              <span
                className="tie-fill"
                style={{ width: `${row.tieRate * 100}%` }}
              />
            </div>
            <span className="row-value">
              {formatPercent(row.tieRate)}
              <small>
                {" "}
                ({row.ties}/{row.games})
              </small>
            </span>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}
