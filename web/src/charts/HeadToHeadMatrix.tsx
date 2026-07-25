import type { AnalyticsModelRef, HeadToHeadPair } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { formatPercent } from "./theme";

export type MatrixMetric = "winRate" | "games";

interface HeadToHeadMatrixProps {
  models: AnalyticsModelRef[];
  pairs: HeadToHeadPair[];
  metric: MatrixMetric;
  onMetricChange: (metric: MatrixMetric) => void;
  selectedPairKey: string | null;
  onSelectPair: (key: string | null) => void;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Blend from red (0) through paper (0.5) to green (1). */
function cellBackground(rate: number): string {
  const from = rate < 0.5 ? [196, 103, 77] : [63, 138, 95];
  const paper = [245, 243, 241];
  const strength = Math.min(1, Math.abs(rate - 0.5) * 2);
  const channel = (index: number): number =>
    Math.round(
      (paper[index] ?? 0) + ((from[index] ?? 0) - (paper[index] ?? 0)) * strength,
    );
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/**
 * Model-by-model matrix. Each cell reads as "row model vs column model":
 * either the row model's share of decided-plus-tied games won, or the raw
 * sample count. Cells are clickable to drive the pair drill-down.
 */
export default function HeadToHeadMatrix({
  models,
  pairs,
  metric,
  onMetricChange,
  selectedPairKey,
  onSelectPair,
}: HeadToHeadMatrixProps) {
  const byKey = new Map(
    pairs.map((pair) => [pairKey(pair.modelAId, pair.modelBId), pair]),
  );

  // Order rows by total games so the busiest models sit top-left.
  const gamesPerModel = new Map<string, number>();
  for (const pair of pairs) {
    gamesPerModel.set(
      pair.modelAId,
      (gamesPerModel.get(pair.modelAId) ?? 0) + pair.games,
    );
    gamesPerModel.set(
      pair.modelBId,
      (gamesPerModel.get(pair.modelBId) ?? 0) + pair.games,
    );
  }
  const ordered = [...models].sort(
    (a, b) => (gamesPerModel.get(b.id) ?? 0) - (gamesPerModel.get(a.id) ?? 0),
  );

  return (
    <ChartCard
      title="Head-to-head matrix"
      subtitle="Row vs column. Win rate counts ties in the denominator; grey cells are pairs the matchmaker has not sampled yet. Click a cell to inspect the pair."
      emptyMessage={
        pairs.length === 0 ? "No sampled pairs yet — vote on some matchups first." : null
      }
      actions={
        <>
          <button
            type="button"
            className={metric === "winRate" ? "active" : ""}
            onClick={() => onMetricChange("winRate")}
          >
            Win rate
          </button>
          <button
            type="button"
            className={metric === "games" ? "active" : ""}
            onClick={() => onMetricChange("games")}
          >
            Games
          </button>
        </>
      }
    >
      <div className="matrix-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th aria-label="Model" />
              {ordered.map((column) => (
                <th key={column.id} scope="col" title={column.displayName}>
                  {column.displayName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => (
              <tr key={row.id}>
                <th scope="row" title={row.displayName}>
                  {row.displayName}
                </th>
                {ordered.map((column) => {
                  if (row.id === column.id) {
                    return <td key={column.id} className="cell-self" />;
                  }
                  const key = pairKey(row.id, column.id);
                  const pair = byKey.get(key);
                  if (!pair) {
                    return (
                      <td key={column.id} className="cell-empty">
                        –
                      </td>
                    );
                  }
                  const rowWins =
                    pair.modelAId === row.id ? pair.aWins : pair.bWins;
                  const rate = rowWins / pair.games;
                  const label =
                    metric === "winRate" ? formatPercent(rate) : pair.games;
                  const columnWins = pair.games - pair.ties - rowWins;
                  return (
                    <td
                      key={column.id}
                      className={selectedPairKey === key ? "cell-selected" : ""}
                      style={{
                        background:
                          metric === "winRate"
                            ? cellBackground(rate)
                            : undefined,
                        cursor: "pointer",
                      }}
                      title={`${row.displayName} vs ${column.displayName}: ${rowWins}W ${pair.ties}T ${columnWins}L (${pair.games} games)`}
                      onClick={() =>
                        onSelectPair(selectedPairKey === key ? null : key)
                      }
                    >
                      {label}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
