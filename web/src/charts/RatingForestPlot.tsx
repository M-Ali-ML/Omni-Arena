import type { LeaderboardModel } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { formatRating, linearScale, niceStep } from "./theme";

interface RatingForestPlotProps {
  models: LeaderboardModel[];
}

/**
 * Forest plot of Bradley-Terry ratings with 95% confidence-interval whiskers.
 * Overlapping intervals mean the models are not statistically separated yet.
 */
export default function RatingForestPlot({ models }: RatingForestPlotProps) {
  const rows = models
    .filter(
      (
        model,
      ): model is LeaderboardModel & {
        rating: number;
        confidenceInterval: { lower: number; upper: number };
      } => model.rating !== null && model.confidenceInterval !== null,
    )
    .sort((a, b) => b.rating - a.rating);

  const lows = rows.map((row) => row.confidenceInterval.lower);
  const highs = rows.map((row) => row.confidenceInterval.upper);
  const pad = 20;
  const min = Math.min(...lows, 1000) - pad;
  const max = Math.max(...highs, 1000) + pad;
  const scale = linearScale(min, max, niceStep(max - min));

  const componentIds = new Set(rows.map((row) => row.componentId));
  const split = componentIds.size > 1;

  return (
    <ChartCard
      title="Bradley-Terry rating (95% CI)"
      subtitle="Rating on an Elo-like scale with confidence whiskers. When two whiskers overlap, the arena has not separated those models yet."
      emptyMessage={
        rows.length === 0
          ? "No ratings yet — they appear once the rating worker has processed enough votes."
          : null
      }
    >
      {split && (
        <p className="chart-warning">
          Models fall in {componentIds.size} disconnected comparison groups;
          ratings are only comparable within a group.
        </p>
      )}
      <div className="forest">
        {rows.map((row, index) => {
          const lowerLeft = scale.pct(row.confidenceInterval.lower);
          const upperLeft = scale.pct(row.confidenceInterval.upper);
          const ratingLeft = scale.pct(row.rating);
          const halfWidth = Math.round(
            (row.confidenceInterval.upper - row.confidenceInterval.lower) / 2,
          );
          return (
            <div className="lollipop-row" key={row.id}>
              <span className="rank-badge">{index + 1}</span>
              <span className="row-label" title={row.displayName}>
                {row.displayName}
                {split && row.componentId !== null && (
                  <span className="component-chip">g{row.componentId}</span>
                )}
              </span>
              <div className="row-track">
                <span
                  className="whisker"
                  style={{
                    left: `${lowerLeft}%`,
                    width: `${upperLeft - lowerLeft}%`,
                  }}
                />
                <span className="whisker-cap" style={{ left: `${lowerLeft}%` }} />
                <span className="whisker-cap" style={{ left: `${upperLeft}%` }} />
                <span className="dot dot-ink" style={{ left: `${ratingLeft}%` }} />
              </div>
              <span className="row-value">
                {formatRating(row.rating)}
                <small> ±{halfWidth}</small>
              </span>
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
                {tick}
              </span>
            ))}
          </div>
          <span className="row-value" aria-hidden="true" />
        </div>
      </div>
    </ChartCard>
  );
}
