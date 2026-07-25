import { useState } from "react";
import {
  useArenaActivity,
  useArenaRatingHistory,
  type ActivityBucketSize,
} from "@omni-arena/react";
import CumulativeGamesLines from "../charts/CumulativeGamesLines";
import RatingHistoryLines from "../charts/RatingHistoryLines";
import VoteVolumeArea from "../charts/VoteVolumeArea";

export default function ActivityTab() {
  const [bucket, setBucket] = useState<ActivityBucketSize>("day");
  const activity = useArenaActivity({ bucket });
  const history = useArenaRatingHistory();

  const bucketToggle = (
    <>
      <button
        type="button"
        className={bucket === "day" ? "active" : ""}
        onClick={() => setBucket("day")}
      >
        Daily
      </button>
      <button
        type="button"
        className={bucket === "hour" ? "active" : ""}
        onClick={() => setBucket("hour")}
      >
        Hourly
      </button>
    </>
  );

  return (
    <div className="tab-panel">
      {activity.error && <p className="error-banner">{activity.error}</p>}
      <div className="chart-grid">
        <RatingHistoryLines history={history.data} />
        <VoteVolumeArea activity={activity.data} actions={bucketToggle} />
        <CumulativeGamesLines activity={activity.data} />
      </div>
    </div>
  );
}
