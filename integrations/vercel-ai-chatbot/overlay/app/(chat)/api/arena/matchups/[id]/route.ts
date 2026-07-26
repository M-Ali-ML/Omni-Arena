import { connection } from "next/server";
import { arenaFetch } from "@/lib/arena/server";
import { ChatbotError } from "@/lib/errors";

/**
 * Proxy for GET /api/arena/matchups/:matchupId.
 * Reads a round back from OmniArena out-of-band: shape, votability, and (if voted)
 * the model reveal and continuation state.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await connection();
  const { id } = await params;

  try {
    const response = await arenaFetch(`/api/arena/matchups/${id}`, {
      headers: { accept: "application/json" },
      method: "GET",
    });

    return Response.json(await response.json(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }
    console.error("Unhandled error in arena matchup read API:", error);
    return new ChatbotError("offline:chat").toResponse();
  }
}
