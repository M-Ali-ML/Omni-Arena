import type { LeaderboardModel } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { chartColors } from "./theme";

interface RankShiftBumpProps {
  models: LeaderboardModel[];
}

const ROW_HEIGHT = 34;
const COLUMN_GAP = 180;
const LABEL_WIDTH = 170;

/**
 * Two-column bump chart: rank by raw rating on the left, rank by
 * style-controlled rating on the right. Crossing lines are models whose
 * position depends on style effects.
 */
export default function RankShiftBump({ models }: RankShiftBumpProps) {
  const rated = models.filter(
    (
      model,
    ): model is LeaderboardModel & {
      rating: number;
      styleControlledRating: number;
    } => model.rating !== null && model.styleControlledRating !== null,
  );

  const rawOrder = [...rated].sort((a, b) => b.rating - a.rating);
  const styleOrder = [...rated].sort(
    (a, b) => b.styleControlledRating - a.styleControlledRating,
  );
  const styleRank = new Map(styleOrder.map((model, index) => [model.id, index]));

  const height = rawOrder.length * ROW_HEIGHT + 28;
  const width = LABEL_WIDTH * 2 + COLUMN_GAP;
  const leftX = LABEL_WIDTH;
  const rightX = LABEL_WIDTH + COLUMN_GAP;
  const rowY = (index: number): number => 28 + index * ROW_HEIGHT;

  return (
    <ChartCard
      title="Rank shift under style control"
      subtitle="Left column: raw rating rank. Right column: rank once style effects are removed. Red lines drop, green lines climb."
      emptyMessage={
        rated.length < 2
          ? "Needs at least two models with both raw and style-controlled ratings."
          : null
      }
    >
      <svg
        className="bump-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Rank comparison between raw and style-controlled ratings"
      >
        <text x={leftX} y={14} textAnchor="end" className="bump-heading">
          Raw
        </text>
        <text x={rightX} y={14} textAnchor="start" className="bump-heading">
          Style-controlled
        </text>
        {rawOrder.map((model, rawIndex) => {
          const targetIndex = styleRank.get(model.id) ?? rawIndex;
          const moved = targetIndex - rawIndex;
          const stroke =
            moved > 0
              ? chartColors.negative
              : moved < 0
                ? chartColors.positive
                : chartColors.grid;
          const y1 = rowY(rawIndex);
          const y2 = rowY(targetIndex);
          return (
            <g key={model.id}>
              <line
                x1={leftX + 8}
                y1={y1}
                x2={rightX - 8}
                y2={y2}
                stroke={stroke}
                strokeWidth={moved === 0 ? 1.5 : 2}
              />
              <circle cx={leftX + 8} cy={y1} r={4} fill={chartColors.ink} />
              <circle cx={rightX - 8} cy={y2} r={4} fill={chartColors.ink} />
              <text x={leftX} y={y1 + 4} textAnchor="end" className="bump-label">
                {rawIndex + 1}. {model.displayName}
              </text>
              <text
                x={rightX}
                y={y2 + 4}
                textAnchor="start"
                className="bump-label"
              >
                {targetIndex + 1}. {model.displayName}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartCard>
  );
}
