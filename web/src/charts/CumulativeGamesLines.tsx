import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ActivityStats } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { chartColors, seriesColor } from "./theme";
import { formatBucket } from "./VoteVolumeArea";

interface CumulativeGamesLinesProps {
  activity: ActivityStats | null;
}

/**
 * Sampling progress: cumulative judged (non-skip) games per model. Models
 * whose lines lag are under-sampled and carry wider rating intervals.
 */
export default function CumulativeGamesLines({
  activity,
}: CumulativeGamesLinesProps) {
  const buckets = activity?.cumulativeGames ?? [];
  const bucket = activity?.bucket ?? "day";
  const models = activity?.models ?? [];

  const rows = buckets.map((entry) => ({
    bucketStart: entry.bucketStart,
    ...entry.games,
  }));
  const active = models.filter((model) =>
    buckets.some((entry) => model.id in entry.games),
  );

  return (
    <ChartCard
      title="Sampling progress"
      subtitle="Cumulative judged games per model. Lagging lines mean the matchmaker still owes that model exposure."
      emptyMessage={rows.length === 0 ? "No judged games yet." : null}
    >
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={rows} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
          <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="bucketStart"
            tickFormatter={(value: string) => formatBucket(value, bucket)}
            stroke={chartColors.muted}
          />
          <YAxis allowDecimals={false} stroke={chartColors.muted} width={40} />
          <Tooltip
            labelFormatter={(label) => formatBucket(String(label), bucket)}
          />
          <Legend />
          {active.map((model, index) => (
            <Line
              key={model.id}
              type="stepAfter"
              dataKey={model.id}
              name={model.displayName}
              stroke={seriesColor(index)}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
