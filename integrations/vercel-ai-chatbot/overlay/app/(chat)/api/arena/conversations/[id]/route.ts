import { connection } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { arenaFetch } from "@/lib/arena/server";
import { ChatbotError } from "@/lib/errors";

/**
 * Proxy for GET /api/arena/conversations/:conversationId.
 * Rehydrates a full OmniArena thread for the current session.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await connection();
  const { id } = await params;

  try {
    const session = await auth();
    const sessionId = session?.user?.id;

    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const response = await arenaFetch(`/api/arena/conversations/${id}${query}`, {
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
    console.error("Unhandled error in arena conversation read API:", error);
    return new ChatbotError("offline:chat").toResponse();
  }
}
