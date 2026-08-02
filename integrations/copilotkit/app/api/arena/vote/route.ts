import { arenaUrl } from "@/lib/arena/server";

/**
 * Same-origin proxy onto `POST /api/arena/vote`. The browser never learns
 * where OmniArena lives; the vote token arrived via the matchup cache poll.
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
    // Deliberately vague: the upstream URL must not leave the server.
    return Response.json(
      {
        error: `Cannot reach OmniArena: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 502 },
    );
  }
}
