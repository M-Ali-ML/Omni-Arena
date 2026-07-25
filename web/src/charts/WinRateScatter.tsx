import {
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import ChartCard from "./ChartCard";
import { chartColors, formatPercent, seriesColor } from "./theme";
import type { ReactNode } from "react";

export interface ScatterPoint {
  name: string;
  x: number;
  y: number;
  games: number;
}

interface WinRateScatterProps {
  title: string;
  subtitle: string;
  xLabel: string;
  xFormat?: (value: number) => string;
  points: ScatterPoint[];
  emptyMessage: string;
  actions?: ReactNode;
}

/**
 * Generic "does trait X buy wins?" scatter: one bubble per model, trait on
 * the x axis, win rate on the y axis, bubble area scaled by sample size.
 */
export default function WinRateScatter({
  title,
  subtitle,
  xLabel,
  xFormat,
  points,
  emptyMessage,
  actions,
}: WinRateScatterProps) {
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      emptyMessage={points.length === 0 ? emptyMessage : null}
      actions={actions}
    >
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 24, right: 32, bottom: 8, left: 0 }}>
          <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="x"
            name={xLabel}
            domain={["auto", "auto"]}
            tickFormatter={xFormat}
            stroke={chartColors.muted}
            label={{
              value: xLabel,
              position: "insideBottom",
              offset: -4,
              fill: chartColors.muted,
              fontSize: 11,
            }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="win rate"
            domain={[0, 1]}
            tickFormatter={(value: number) => formatPercent(value)}
            stroke={chartColors.muted}
            width={48}
          />
          <ZAxis dataKey="games" range={[80, 400]} name="games" />
          <ReferenceLine
            y={0.5}
            stroke={chartColors.neutral}
            strokeDasharray="4 4"
          />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            formatter={(value: unknown, name: unknown) => {
              if (typeof value !== "number") {
                return value as string;
              }
              if (name === xLabel) {
                return xFormat ? xFormat(value) : String(value);
              }
              return name === "win rate" ? formatPercent(value) : String(value);
            }}
          />
          <Scatter data={points} isAnimationActive={false}>
            <LabelList
              dataKey="name"
              position="top"
              style={{ fontSize: 11, fill: chartColors.ink }}
            />
            {points.map((point, index) => (
              <Cell key={point.name} fill={seriesColor(index)} fillOpacity={0.85} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
