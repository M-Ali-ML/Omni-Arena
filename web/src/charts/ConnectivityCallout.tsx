import type { LeaderboardModel } from "@omni-arena/react";
import ChartCard from "./ChartCard";

interface ConnectivityCalloutProps {
  models: LeaderboardModel[];
}

/**
 * Groups models by the rating worker's connected-component id. Ratings are
 * only comparable within a component, so more than one group is a warning
 * that the matchmaker still has bridging games to play.
 */
export default function ConnectivityCallout({
  models,
}: ConnectivityCalloutProps) {
  const groups = new Map<number, LeaderboardModel[]>();
  const unrated: LeaderboardModel[] = [];
  for (const model of models) {
    if (model.componentId === null) {
      unrated.push(model);
    } else {
      const group = groups.get(model.componentId) ?? [];
      group.push(model);
      groups.set(model.componentId, group);
    }
  }

  return (
    <ChartCard
      title="Comparison-graph connectivity"
      subtitle="Ratings are only comparable between models in the same connected group of the matchup graph."
      emptyMessage={
        groups.size === 0
          ? "No rated models yet — connectivity appears once the rating worker has run."
          : null
      }
    >
      {groups.size > 1 && (
        <p className="chart-warning">
          The comparison graph is split into {groups.size} groups. Ratings in
          different groups cannot be compared until matchups bridge them.
        </p>
      )}
      <div className="component-groups">
        {[...groups.entries()]
          .sort(([a], [b]) => a - b)
          .map(([componentId, group]) => (
            <div className="component-group" key={componentId}>
              <p className="stat-label">Group {componentId}</p>
              <ul>
                {group.map((model) => (
                  <li key={model.id}>{model.displayName}</li>
                ))}
              </ul>
            </div>
          ))}
        {unrated.length > 0 && (
          <div className="component-group component-group-unrated">
            <p className="stat-label">Not rated yet</p>
            <ul>
              {unrated.map((model) => (
                <li key={model.id}>{model.displayName}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ChartCard>
  );
}
