import type { StyleControlReport, StyleEffect } from "@omni-arena/react";
import ChartCard from "../charts/ChartCard";

interface StyleControlPanelProps {
  styleControl: StyleControlReport;
}

/** Reader-facing name per worker feature, and what "more of it" means. */
const featureLabels: Record<string, string> = {
  position: "Left slot",
  verbosity: "Verbosity",
  formatting: "Formatting",
  latency_ttft: "Time to first token",
  latency_duration: "Stream duration",
};

function formatPoints(points: number): string {
  return `${points < 0 ? "−" : "+"}${Math.abs(points).toFixed(1)}`;
}

/** What the headline number is measured against. */
function describeBasis(effect: StyleEffect): string {
  if (effect.perUnit) {
    return `per ${effect.perUnit.unit}`;
  }
  return effect.basis === "absolute"
    ? "on every comparison"
    : "per standard deviation";
}

/**
 * The style confounders the rating worker fits jointly with model strength
 * (docs/md/rating-methodology.md), converted to rating points so a reader can weigh them against
 * the gaps in the leaderboard above.
 */
export default function StyleControlPanel({
  styleControl,
}: StyleControlPanelProps) {
  return (
    <ChartCard
      title="What style is worth"
      subtitle="Voter biases estimated inside the rating regression, in leaderboard points."
      emptyMessage={
        styleControl.effects.length === 0
          ? "No style coefficients yet — they appear once the worker's style-controlled pass has run."
          : null
      }
    >
      <ul className="style-effects">
        {styleControl.effects.map((effect) => (
          <li key={effect.feature}>
            <span className="style-effect-name">
              {featureLabels[effect.feature] ?? effect.feature}
            </span>
            <span className="style-effect-basis">{describeBasis(effect)}</span>
            <strong
              title={`${effect.logOdds.toFixed(4)} log-odds · ${formatPoints(
                effect.points,
              )} points ${
                effect.basis === "absolute"
                  ? "outright"
                  : "per standard deviation of the vote-level delta"
              }`}
            >
              {formatPoints(effect.perUnit?.points ?? effect.points)}
            </strong>
          </li>
        ))}
      </ul>
      <p className="chart-footnote">
        Points use the leaderboard's scale (400/ln 10 per unit of log-odds); a
        positive number favours the response with more of that trait. Per-unit
        figures un-standardise the fitted coefficient with the spread of{" "}
        {styleControl.votesObserved.toLocaleString()} votes, so they shift as the
        arena collects more.
      </p>
    </ChartCard>
  );
}
