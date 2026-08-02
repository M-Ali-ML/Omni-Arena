import { matchupCache } from "@/lib/arena/matchup-cache";

/**
 * Same-origin read of matchup metadata stashed by ArenaHttpAgent's fetch
 * wrapper. The browser polls this after a run because it cannot see the
 * server-side `x-arena-matchup` response header.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const threadId = new URL(request.url).searchParams.get("threadId");
  if (!threadId) {
    return Response.json(
      { error: "threadId query parameter is required" },
      { status: 400 },
    );
  }
  const matchup = matchupCache.get(threadId);
  if (!matchup) {
    return Response.json({ error: "No matchup for thread" }, { status: 404 });
  }
  return Response.json(matchup);
}
