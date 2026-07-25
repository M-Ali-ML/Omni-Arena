import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ActivityStats } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { chartColors } from "./theme";
import type { ReactNode } from "react";

interface VoteVolumeAreaProps {
  activity: ActivityStats | null;
  actions?: ReactNode;
}

const series = [
  { key: "left", label: "A wins", color: chartColors.positive },
  { key: "right", label: "B wins", color: "#5b7fa6" },
  { key: "bothGood", label: "both good", color: chartColors.positiveSoft },
  { key: "bothBad", label: "both bad", color: chartColors.negativeSoft },
  { key: "skip", label: "skips", color: chartColors.neutral },
] as const;

export function formatBucket(iso: string, bucket: "day" | "hour"): string {
  const date = new Date(iso);
  return bucket === "day"
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
      });
}

/** Stacked vote volume per bucket, split by how the vote resolved. */
export default function VoteVolumeArea({
  activity,
  actions,
}: VoteVolumeAreaProps) {
  const votes = activity?.votes ?? [];
  const bucket = activity?.bucket ?? "day";

  return (
    <ChartCard
      title="Vote volume"
      subtitle="How much evaluation signal the arena is collecting, split by outcome type."
      emptyMessage={votes.length === 0 ? "No votes recorded yet." : null}
      actions={actions}
    >
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart
          data={votes}
          margin={{ top: 8, right: 24, bottom: 8, left: 0 }}
        >
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
          {series.map((entry) => (
            <Area
              key={entry.key}
              dataKey={entry.key}
              name={entry.label}
              stackId="votes"
              stroke={entry.color}
              fill={entry.color}
              fillOpacity={0.75}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
