import { arenaUrl } from "@/lib/arena/server";

/**
 * Same-origin proxy for conversation rehydration after a reload.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ conversationId: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { conversationId } = await context.params;
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  const query = sessionId
    ? `?sessionId=${encodeURIComponent(sessionId)}`
    : "";

  try {
    const upstream = await fetch(
      `${arenaUrl()}/api/arena/conversations/${encodeURIComponent(conversationId)}${query}`,
      { headers: { accept: "application/json" } },
    );
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
