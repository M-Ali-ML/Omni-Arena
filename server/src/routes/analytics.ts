import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AnalyticsPort } from "../core/ports.js";

const activityQuery = z.object({
  bucket: z.enum(["day", "hour"]).default("day"),
});

const historyQuery = z.object({
  since: z.string().datetime({ offset: true }).optional(),
});

/**
 * Read-only aggregate endpoints backing the insights dashboard. Like the
 * leaderboard, they expose no per-user data — only model-level aggregates.
 */
export function registerAnalyticsRoutes(
  app: FastifyInstance,
  analytics: AnalyticsPort,
): void {
  app.get("/api/arena/analytics/summary", async () => analytics.getSummary());

  app.get("/api/arena/analytics/head-to-head", async () =>
    analytics.getHeadToHead(),
  );

  app.get("/api/arena/analytics/model-metrics", async () => ({
    models: await analytics.getModelMetrics(),
  }));

  app.get("/api/arena/analytics/activity", async (request, reply) => {
    const parsed = activityQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "bucket must be 'day' or 'hour'" });
    }
    return analytics.getActivity(parsed.data.bucket);
  });

  app.get("/api/arena/analytics/style-control", async () =>
    analytics.getStyleControl(),
  );

  app.get("/api/arena/analytics/rating-history", async (request, reply) => {
    const parsed = historyQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "since must be an ISO 8601 timestamp" });
    }
    return analytics.getRatingHistory(
      parsed.data.since ? new Date(parsed.data.since) : null,
    );
  });
}
