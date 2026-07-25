import type { LeaderboardModel } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { formatRating, linearScale, niceStep } from "./theme";

interface StyleDumbbellProps {
  models: LeaderboardModel[];
}

/**
 * Dumbbell chart connecting each model's raw rating to its style-controlled
 * rating: how much of the score is substance vs. verbosity, formatting,
 * latency, and position effects.
 */
export default function StyleDumbbell({ models }: StyleDumbbellProps) {
  const rows = models
    .filter(
      (
        model,
      ): model is LeaderboardModel & {
        rating: number;
        styleControlledRating: number;
      } => model.rating !== null && model.styleControlledRating !== null,
    )
    .sort((a, b) => b.rating - a.rating);

  const values = rows.flatMap((row) => [row.rating, row.styleControlledRating]);
  const pad = 20;
  const min = Math.min(...values, 1000) - pad;
  const max = Math.max(...values, 1000) + pad;
  const scale = linearScale(min, max, niceStep(max - min));

  return (
    <ChartCard
      title="Raw vs style-controlled rating"
      subtitle="The hollow dot is the raw rating; the filled dot is the rating with verbosity, formatting, latency, and position regressed out. A big leftward move means style, not substance, was buying wins."
      emptyMessage={
        rows.length === 0
          ? "Style-controlled ratings appear once the worker's periodic style pass has run."
          : null
      }
    >
      <div className="dumbbell">
        <div className="dumbbell-legend">
          <span>
            <span className="dot dot-hollow legend-dot" /> raw
          </span>
          <span>
            <span className="dot dot-ink legend-dot" /> style-controlled
          </span>
        </div>
        {rows.map((row) => {
          const rawLeft = scale.pct(row.rating);
          const styleLeft = scale.pct(row.styleControlledRating);
          const delta = row.styleControlledRating - row.rating;
          return (
            <div className="lollipop-row" key={row.id}>
              <span className="row-label" title={row.displayName}>
                {row.displayName}
              </span>
              <div className="row-track">
                <span
                  className="stem stem-neutral"
                  style={{
                    left: `${Math.min(rawLeft, styleLeft)}%`,
                    width: `${Math.abs(rawLeft - styleLeft)}%`,
                  }}
                />
                <span className="dot dot-hollow" style={{ left: `${rawLeft}%` }} />
                <span className="dot dot-ink" style={{ left: `${styleLeft}%` }} />
              </div>
              <span
                className={`row-value ${delta >= 0 ? "value-above" : "value-below"}`}
                title="Style-controlled minus raw rating"
              >
                {delta >= 0 ? "+" : ""}
                {formatRating(delta)}
              </span>
            </div>
          );
        })}
        <div className="lollipop-row axis-row">
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
