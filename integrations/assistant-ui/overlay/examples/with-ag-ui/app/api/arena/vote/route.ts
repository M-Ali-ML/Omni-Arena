import { arenaUrl } from "@/lib/arena/server";

/**
 * Records the blind vote and returns OmniArena's reveal
 * (`{ accepted, models: { A, B } }`). The vote token this needs arrived on the
 * AG-UI stream in the `CUSTOM arena_matchup` event.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  try {
    const upstream = await fetch(`${arenaUrl()}/api/arena/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return Response.json(
      {
        error: `Cannot reach OmniArena at ${arenaUrl()}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 502 },
    );
  }
}
