import type {
  AnalyticsModelRef,
  HeadToHeadPair,
  ModelMetricsEntry,
} from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { formatPercent } from "./theme";

interface PairDrilldownProps {
  pair: HeadToHeadPair | null;
  models: AnalyticsModelRef[];
  metrics: ModelMetricsEntry[];
}

function formatMs(value: number | null): string {
  if (value === null) {
    return "–";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/** Record + style profile for the pair selected in the matrix. */
export default function PairDrilldown({
  pair,
  models,
  metrics,
}: PairDrilldownProps) {
  const names = new Map(models.map((model) => [model.id, model.displayName]));
  const sides = pair
    ? [
        { id: pair.modelAId, wins: pair.aWins },
        { id: pair.modelBId, wins: pair.bWins },
      ]
    : [];

  return (
    <ChartCard
      title="Pair drill-down"
      subtitle="Select a cell in the matrix to inspect one rivalry: the record, tie share, and each side's pace and verbosity profile."
      emptyMessage={pair ? null : "No pair selected."}
    >
      {pair && (
        <>
          <div className="pair-record">
            <span className="pair-score">
              {names.get(pair.modelAId)} {pair.aWins} · {pair.ties} ·{" "}
              {pair.bWins} {names.get(pair.modelBId)}
            </span>
            <span className="pair-note">
              {pair.games} games, {formatPercent(pair.ties / pair.games)} ties
            </span>
          </div>
          <div className="pair-sides">
            {sides.map((side) => {
              const metric = metrics.find((entry) => entry.id === side.id);
              return (
                <div className="pair-side" key={side.id}>
                  <p className="stat-label">{names.get(side.id)}</p>
                  <dl>
                    <div>
                      <dt>Wins vs rival</dt>
                      <dd>
                        {side.wins} ({formatPercent(side.wins / pair.games)})
                      </dd>
                    </div>
                    <div>
                      <dt>Median TTFT</dt>
                      <dd>{formatMs(metric?.ttftMsP50 ?? null)}</dd>
                    </div>
                    <div>
                      <dt>Median stream</dt>
                      <dd>{formatMs(metric?.durationMsP50 ?? null)}</dd>
                    </div>
                    <div>
                      <dt>Mean tokens</dt>
                      <dd>
                        {metric?.meanOutputTokens === null ||
                        metric === undefined
                          ? "–"
                          : Math.round(metric.meanOutputTokens)}
                      </dd>
                    </div>
                    <div>
                      <dt>Markdown density</dt>
                      <dd>
                        {metric?.meanMarkdownDensity === null ||
                        metric === undefined
                          ? "–"
                          : metric.meanMarkdownDensity.toFixed(2)}
                      </dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
        </>
      )}
    </ChartCard>
  );
}
