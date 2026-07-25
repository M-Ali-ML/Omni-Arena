import type { LeaderboardComponents } from "@omni-arena/react";

interface ComponentNoticeProps {
  components: LeaderboardComponents;
}

/**
 * States plainly whether the leaderboard's ratings are comparable at all
 * (vision §4). Bradley-Terry strengths are identified only up to a constant
 * *per connected component*, so two ratings from different components sit on
 * unrelated scales — a reader who is not told will silently compare them.
 * Stays a quiet one-liner in the normal single-component case.
 */
export default function ComponentNotice({ components }: ComponentNoticeProps) {
  const { count, groups } = components;
  if (count === null) {
    return null;
  }

  if (count === 1) {
    const rated = groups[0]?.models ?? 0;
    return (
      <p className="component-note">
        All {rated} rated {rated === 1 ? "model" : "models"} are in one connected
        group, so their ratings are directly comparable.
      </p>
    );
  }

  return (
    <p className="chart-warning">
      The comparison graph is split into {count} groups (
      {groups.map((group) => group.models).join(" + ")} models). Ratings are only
      defined within a group, so a number from one group cannot be compared with
      a number from another — rows are labelled below. More matchups between the
      groups will merge them.
    </p>
  );
}
