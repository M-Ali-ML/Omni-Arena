import type { ModelMetricsEntry } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { formatPercent, linearScale } from "./theme";

interface PositionBiasDumbbellProps {
  metrics: ModelMetricsEntry[];
  /** Global slot-A share of decided games, or null with no decided games. */
  globalSlotAShare: number | null;
}

/**
 * Per-model win rate split by which side of the screen the model was shown
 * on. A consistent gap between the two dots is position bias, not model
 * quality — the style-control pass regresses it out.
 */
export default function PositionBiasDumbbell({
  metrics,
  globalSlotAShare,
}: PositionBiasDumbbellProps) {
  const rows = metrics
    .filter((entry) => entry.slotAGames > 0 && entry.slotBGames > 0)
    .map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      slotARate: entry.slotAWins / entry.slotAGames,
      slotBRate: entry.slotBWins / entry.slotBGames,
      slotAGames: entry.slotAGames,
      slotBGames: entry.slotBGames,
    }))
    .sort((a, b) => b.slotARate - b.slotBRate - (a.slotARate - a.slotBRate));

  const scale = linearScale(0, 1, 0.25);

  return (
    <ChartCard
      title="Position bias"
      subtitle={
        globalSlotAShare === null
          ? "Win rate when shown as response A vs response B."
          : `Across all decided games, the left (A) response wins ${formatPercent(globalSlotAShare)} of the time — 50% means no position bias.`
      }
      emptyMessage={
        rows.length === 0
          ? "Needs decided votes with each model having appeared in both slots."
          : null
      }
    >
      <div className="dumbbell">
        <div className="dumbbell-legend">
          <span>
            <span className="dot dot-hollow legend-dot" /> as slot A
          </span>
          <span>
            <span className="dot dot-ink legend-dot" /> as slot B
          </span>
        </div>
        {rows.map((row) => {
          const aLeft = scale.pct(row.slotARate);
          const bLeft = scale.pct(row.slotBRate);
          return (
            <div className="lollipop-row bias-row" key={row.id}>
              <span className="row-label" title={row.displayName}>
                {row.displayName}
              </span>
              <div
                className="row-track"
                title={`As A: ${formatPercent(row.slotARate)} of ${row.slotAGames} · As B: ${formatPercent(row.slotBRate)} of ${row.slotBGames}`}
              >
                <span
                  className="stem stem-neutral"
                  style={{
                    left: `${Math.min(aLeft, bLeft)}%`,
                    width: `${Math.abs(aLeft - bLeft)}%`,
                  }}
                />
                <span className="dot dot-hollow" style={{ left: `${aLeft}%` }} />
                <span className="dot dot-ink" style={{ left: `${bLeft}%` }} />
              </div>
              <span className="row-value">
                {formatPercent(row.slotARate)}
                <small> / {formatPercent(row.slotBRate)}</small>
              </span>
            </div>
          );
        })}
        <div className="lollipop-row bias-row axis-row">
          <span className="row-label" aria-hidden="true" />
          <div className="row-track row-axis">
            {scale.ticks.map((tick) => (
              <span
                className="axis-tick"
                key={tick}
                style={{ left: `${scale.pct(tick)}%` }}
              >
                {formatPercent(tick)}
              </span>
            ))}
          </div>
          <span className="row-value" aria-hidden="true" />
        </div>
      </div>
    </ChartCard>
  );
}
