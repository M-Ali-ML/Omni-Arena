import type { LeaderboardModel } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { formatPercent, linearScale } from "./theme";

interface WinRateLollipopProps {
  models: LeaderboardModel[];
}

/**
 * Ranked horizontal lollipop chart of win rates diverging from a 50%
 * reference line: green stems above 50%, red stems below.
 */
export default function WinRateLollipop({ models }: WinRateLollipopProps) {
  const rows = models
    .filter((model) => model.wins + model.losses + model.ties > 0)
    .sort((a, b) => b.winRate - a.winRate);

  const rates = rows.map((row) => row.winRate);
  const min = Math.min(0.2, ...rates.map((rate) => rate - 0.05));
  const max = Math.max(0.8, ...rates.map((rate) => rate + 0.05));
  const scale = linearScale(
    Math.max(0, Math.floor(min * 10) / 10),
    Math.min(1, Math.ceil(max * 10) / 10),
    0.1,
  );
  const refLeft = scale.pct(0.5);

  return (
    <ChartCard
      title="Win rate"
      subtitle="Share of decided games won (ties count in the denominator, skips excluded). The dotted line is the 50% break-even mark."
      emptyMessage={rows.length === 0 ? "No decided votes yet — win rates appear after the first vote." : null}
    >
      <div className="lollipop">
        <div className="lollipop-legend">
          <span className="legend-below">← BELOW</span>
          <span className="legend-pill">50%</span>
          <span className="legend-above">ABOVE →</span>
        </div>
        {rows.map((row, index) => {
          const valueLeft = scale.pct(row.winRate);
          const above = row.winRate >= 0.5;
          const stemLeft = Math.min(refLeft, valueLeft);
          const stemWidth = Math.abs(valueLeft - refLeft);
          return (
            <div className="lollipop-row" key={row.id}>
              <span className="rank-badge">{index + 1}</span>
              <span className="row-label" title={row.displayName}>
                {row.displayName}
              </span>
              <div className="row-track">
                <span className="ref-line" style={{ left: `${refLeft}%` }} />
                <span
                  className={`stem ${above ? "stem-above" : "stem-below"}`}
                  style={{ left: `${stemLeft}%`, width: `${stemWidth}%` }}
                />
                <span
                  className={`dot ${above ? "dot-above" : "dot-below"}`}
                  style={{ left: `${valueLeft}%` }}
                />
                <span
                  className={`track-value ${above ? "value-above" : "value-below"}`}
                  style={{ left: `${valueLeft}%` }}
                >
                  {formatPercent(row.winRate)}
                </span>
              </div>
            </div>
          );
        })}
        <div className="lollipop-row axis-row">
          <span className="rank-badge" aria-hidden="true" />
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
        </div>
      </div>
    </ChartCard>
  );
}
