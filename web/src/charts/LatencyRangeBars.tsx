import type { ModelMetricsEntry } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { linearScale, niceStep } from "./theme";
import type { ReactNode } from "react";

export type LatencyMetric = "ttft" | "duration";

interface LatencyRangeBarsProps {
  metrics: ModelMetricsEntry[];
  metric: LatencyMetric;
  actions?: ReactNode;
}

export function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/**
 * Median-to-p90 latency range per model: the dot is the median, the bar is
 * the spread up to the 90th percentile.
 */
export default function LatencyRangeBars({
  metrics,
  metric,
  actions,
}: LatencyRangeBarsProps) {
  const rows = metrics
    .map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      p50: metric === "ttft" ? entry.ttftMsP50 : entry.durationMsP50,
      p90: metric === "ttft" ? entry.ttftMsP90 : entry.durationMsP90,
    }))
    .filter(
      (row): row is typeof row & { p50: number; p90: number } =>
        row.p50 !== null && row.p90 !== null,
    )
    .sort((a, b) => a.p50 - b.p50);

  const max = Math.max(...rows.map((row) => row.p90), 1);
  const scale = linearScale(0, max * 1.1, niceStep(max * 1.1, 6));

  return (
    <ChartCard
      title="Latency spread"
      subtitle="Dot: median. Bar: median to 90th percentile. Sorted fastest first."
      emptyMessage={
        rows.length === 0 ? "No timed responses recorded yet." : null
      }
      actions={actions}
    >
      <div className="latency-bars">
        {rows.map((row) => {
          const p50Left = scale.pct(row.p50);
          const p90Left = scale.pct(row.p90);
          return (
            <div className="lollipop-row latency-row" key={row.id}>
              <span className="row-label" title={row.displayName}>
                {row.displayName}
              </span>
              <div
                className="row-track"
                title={`${row.displayName}: p50 ${formatMs(row.p50)}, p90 ${formatMs(row.p90)}`}
              >
                <span
                  className="stem stem-neutral"
                  style={{
                    left: `${p50Left}%`,
                    width: `${p90Left - p50Left}%`,
                  }}
                />
                <span className="whisker-cap" style={{ left: `${p90Left}%` }} />
                <span className="dot dot-ink" style={{ left: `${p50Left}%` }} />
              </div>
              <span className="row-value">
                {formatMs(row.p50)}
                <small> – {formatMs(row.p90)}</small>
              </span>
            </div>
          );
        })}
        <div className="lollipop-row latency-row axis-row">
          <span className="row-label" aria-hidden="true" />
          <div className="row-track row-axis">
            {scale.ticks.map((tick) => (
              <span
                className="axis-tick"
                key={tick}
                style={{ left: `${scale.pct(tick)}%` }}
              >
                {formatMs(tick)}
              </span>
            ))}
          </div>
          <span className="row-value" aria-hidden="true" />
        </div>
      </div>
    </ChartCard>
  );
}
