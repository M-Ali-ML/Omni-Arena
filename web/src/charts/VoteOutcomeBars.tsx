import type { LeaderboardModel } from "@omni-arena/react";
import ChartCard from "./ChartCard";
import { formatPercent } from "./theme";

interface VoteOutcomeBarsProps {
  models: LeaderboardModel[];
}

const segments = [
  { key: "wins", label: "wins", className: "seg-win" },
  { key: "ties", label: "ties", className: "seg-tie" },
  { key: "losses", label: "losses", className: "seg-loss" },
  { key: "skips", label: "skips", className: "seg-skip" },
] as const;

/**
 * 100% stacked bar of each model's vote outcomes: wins, ties (both good/bad),
 * losses, and skips.
 */
export default function VoteOutcomeBars({ models }: VoteOutcomeBarsProps) {
  const rows = models
    .filter((model) => model.totalVotes > 0)
    .sort((a, b) => b.winRate - a.winRate);

  return (
    <ChartCard
      title="Vote outcome mix"
      subtitle="How every vote involving each model resolved. A heavy tie share means users cannot tell the pair apart."
      emptyMessage={rows.length === 0 ? "No votes recorded yet." : null}
    >
      <div className="outcome-legend">
        {segments.map((segment) => (
          <span key={segment.key}>
            <span className={`legend-swatch ${segment.className}`} />
            {segment.label}
          </span>
        ))}
      </div>
      <div className="outcome-bars">
        {rows.map((row) => (
          <div className="lollipop-row" key={row.id}>
            <span className="row-label" title={row.displayName}>
              {row.displayName}
            </span>
            <div className="outcome-bar">
              {segments.map((segment) => {
                const count = row[segment.key];
                if (count === 0) {
                  return null;
                }
                const share = count / row.totalVotes;
                return (
                  <span
                    key={segment.key}
                    className={`outcome-seg ${segment.className}`}
                    style={{ width: `${share * 100}%` }}
                    title={`${segment.label}: ${count} (${formatPercent(share)})`}
                  >
                    {share >= 0.08 ? count : ""}
                  </span>
                );
              })}
            </div>
            <span className="row-value">
              <small>{row.totalVotes} votes</small>
            </span>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}
