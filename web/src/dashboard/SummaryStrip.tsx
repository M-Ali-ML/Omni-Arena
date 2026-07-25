import type { ArenaSummary } from "@omni-arena/react";
import { formatPercent } from "../charts/theme";

interface SummaryStripProps {
  data: ArenaSummary | null;
  error: string | null;
}

/** Arena-wide headline numbers shown above the insight tabs. */
export default function SummaryStrip({ data, error }: SummaryStripProps) {
  if (!data) {
    return error ? <p className="slot-error">{error}</p> : null;
  }

  const decisiveShare =
    data.totalVotes === 0 ? null : data.decisiveVotes / data.totalVotes;
  const decidedGames = data.slotAWins + data.slotBWins;
  const slotABias = decidedGames === 0 ? null : data.slotAWins / decidedGames;
  const coverage =
    data.pairsPossible === 0 ? null : data.pairsSampled / data.pairsPossible;

  return (
    <div className="stat-strip" aria-label="Arena summary">
      <div className="stat-card">
        <p className="stat-label">Matchups</p>
        <p className="stat-value">{data.totalMatchups}</p>
        <p className="stat-note">{data.totalVotes} votes cast</p>
      </div>
      <div className="stat-card">
        <p className="stat-label">Decisive votes</p>
        <p className="stat-value">
          {decisiveShare === null ? "–" : formatPercent(decisiveShare)}
        </p>
        <p className="stat-note">
          {data.tieVotes} ties, {data.skipVotes} skips
        </p>
      </div>
      <div className="stat-card">
        <p className="stat-label">Slot A win share</p>
        <p className="stat-value">
          {slotABias === null ? "–" : formatPercent(slotABias)}
        </p>
        <p className="stat-note">50% means no position bias</p>
      </div>
      <div className="stat-card">
        <p className="stat-label">Pair coverage</p>
        <p className="stat-value">
          {coverage === null ? "–" : formatPercent(coverage)}
        </p>
        <p className="stat-note">
          {data.pairsSampled} of {data.pairsPossible} pairs sampled
        </p>
      </div>
      <div className="stat-card">
        <p className="stat-label">Rating groups</p>
        <p className="stat-value">{data.ratingComponents ?? "–"}</p>
        <p className="stat-note">
          {data.ratingComponents === 1
            ? "fully connected"
            : "connected components"}
        </p>
      </div>
    </div>
  );
}
