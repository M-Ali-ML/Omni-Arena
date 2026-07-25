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
import type { RatingHistoryStats } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { chartColors, seriesColor } from "./theme";

interface RatingHistoryLinesProps {
  history: RatingHistoryStats | null;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One line per model: Bradley-Terry rating across worker refits. */
export default function RatingHistoryLines({
  history,
}: RatingHistoryLinesProps) {
  const points = history?.points ?? [];
  const names = new Map(
    (history?.models ?? []).map((model) => [model.id, model.displayName]),
  );

  // Pivot to one row per snapshot time with a column per model.
  const byTime = new Map<string, Record<string, number | string>>();
  const seenModels: string[] = [];
  for (const point of points) {
    let row = byTime.get(point.computedAt);
    if (!row) {
      row = { computedAt: point.computedAt };
      byTime.set(point.computedAt, row);
    }
    row[point.modelId] = point.rating;
    if (!seenModels.includes(point.modelId)) {
      seenModels.push(point.modelId);
    }
  }
  const rows = [...byTime.values()].sort((a, b) =>
    String(a.computedAt).localeCompare(String(b.computedAt)),
  );

  return (
    <ChartCard
      title="Rating over time"
      subtitle="Each point is one refit by the rating worker. Flat, converging lines mean the arena has settled; snapshots accumulate from now on."
      emptyMessage={
        points.length === 0
          ? "No rating snapshots yet — the worker appends one per refit."
          : null
      }
    >
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={rows} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
          <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="computedAt"
            tickFormatter={formatTimestamp}
            stroke={chartColors.muted}
          />
          <YAxis
            domain={["auto", "auto"]}
            stroke={chartColors.muted}
            width={48}
          />
          <Tooltip
            labelFormatter={(label) => formatTimestamp(String(label))}
            formatter={(value: unknown) =>
              typeof value === "number" ? Math.round(value) : (value as string)
            }
          />
          <Legend />
          {seenModels.map((modelId, index) => (
            <Line
              key={modelId}
              type="monotone"
              dataKey={modelId}
              name={names.get(modelId) ?? modelId}
              stroke={seriesColor(index)}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
