import type { ArenaSummary } from "@omni-arena/react";

interface GettingStartedNoticeProps {
  summary: ArenaSummary | null;
}

/**
 * Turns an empty dashboard into instructions.
 *
 * Every chart here is derived from recorded votes, so a fresh deployment shows
 * nothing but empty cards — and the individual cards can only say *what* is
 * missing, not what to run. This says that once, for whichever step is actually
 * outstanding, and disappears as soon as the data exists.
 */
export default function GettingStartedNotice({ summary }: GettingStartedNoticeProps) {
  if (!summary) {
    return null;
  }

  if (summary.totalVotes === 0) {
    return (
      <aside className="setup-notice" aria-label="Getting started">
        <p className="setup-notice-title">No votes yet, so every chart is empty.</p>
        <p>
          Charts fill in as people vote in the{" "}
          <a href="/">arena</a>. To explore the dashboard immediately, seed a
          synthetic voting history:
        </p>
        <pre>
          <code>npm run db:seed:demo --workspace server</code>
        </pre>
        <p className="setup-notice-note">
          Running in Docker? <code>tsx</code> is pruned from the runtime image, so
          use <code>docker compose exec app node server/dist/db/seed.demo.js</code>{" "}
          instead. Seeded rows are tagged and{" "}
          <code>--reset</code> removes only those, so real votes are never touched.
        </p>
      </aside>
    );
  }

  if (summary.ratingComponents === null) {
    return (
      <aside className="setup-notice" aria-label="Getting started">
        <p className="setup-notice-title">
          Votes are recorded, but no ratings have been fitted yet.
        </p>
        <p>
          Win rates and head-to-head records already work. Bradley-Terry ratings,
          confidence intervals, style control, and rating history stay empty until
          the worker fits them:
        </p>
        <pre>
          <code>cd worker &amp;&amp; uv run python -m omniarena_rating --style</code>
        </pre>
        <p className="setup-notice-note">
          <code>docker compose up</code> runs this on a loop every{" "}
          <code>REFIT_INTERVAL_SECONDS</code> (default 300), but without{" "}
          <code>--style</code> — the style-controlled charts need that flag.
        </p>
      </aside>
    );
  }

  return null;
}
